import re
from datetime import UTC, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import JsonValue, StrictBool, ValidationError
from sqlmodel import Session, col, select

from app.authz.principal import Principal
from app.domains import manager_tools
from app.domains.bot import schemas as s
from app.domains.bot import store
from app.domains.bot.levels import name_levels
from app.domains.bot.models import BotSession
from app.domains.capability.models import (
    CapabilityDefinition,
    CapabilitySchemaVersion,
    SchemaStatus,
)
from app.domains.change_request.employee import (
    EmployeeRecordNotFound,
    InvalidItems,
    RequestConflict,
)
from app.domains.change_request.models import ChangeItem, ItemDecision, ReviewVia
from app.domains.change_request.schemas import ToolInput
from app.domains.employee_tools import RequestInput
from app.domains.model.pi_client import ToolDefinition
from app.domains.org.models import Employee, EmploymentStatus
from app.domains.review import service
from app.domains.review.schemas import DecideInput, DecisionInput, ReviewSummary
from app.i18n import EN_CATALOG, tr

CHANNEL_CLIENTS = {
    "web": "网页",
    "feishu": "飞书",
    "telegram": "Telegram",
    "wecom": "企业微信",
}
BATCH_PATTERNS = (
    "批量",
    "全部",
    "所有",
    "这几条",
    "几条",
    "两条",
    "三条",
    "多条",
    "全批",
    "全拒",
    "都批",
    "都拒",
    "一起批",
    "一起拒",
    "一并",
    "统一",
    "全都",
    "都通过",
    "都同意",
)
_ENGLISH_BATCH_RE = re.compile(
    r"\b(?:batch|approve\s+all|reject\s+all|decline\s+all|deny\s+all"
    r"|approve\s+everything|reject\s+everything|decline\s+everything|deny\s+everything"
    r"|approve\s+them\s+all|reject\s+them\s+all|all\s+pending|all\s+(?:the\s+)?requests"
    r"|every\s+request|all\s+of\s+them|both|multiple|several)\b",
    re.IGNORECASE,
)
ANAPHORA_PATTERNS = (
    "这条",
    "那条",
    "这个",
    "那个",
    "该条",
    "该请求",
    "此请求",
    "上面这条",
    "刚才那条",
)
_ENGLISH_ANAPHORA_RE = re.compile(
    r"\b(?:this\s+one|that\s+one|this\s+request|that\s+request|the\s+request|this|that)\b",
    re.IGNORECASE,
)
UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
QUOTED_RE = re.compile(
    r'"[^"]*"|“[^”]*”|「[^」]*」|『[^』]*』'
    r"|(?<!\w)'(?:[^']|(?<=\w)'(?=\w))*?'(?!\w)"
    r"|(?<!\w)‘(?:[^’]|(?<=\w)’(?=\w))*?’(?!\w)"
    r"|`[^`]*`"
)
COMPOUND_NOUN_RE = re.compile(
    r"待批准|未批准|待审批|批准人|批准时间|批准状态|批准前|批准后|批准记录|批准结果"
    r"|已批准|被批准|免批准|无需批准|自动批准"
    r"|拒绝原因|拒绝理由|拒绝说明|拒绝记录|拒绝结果|已拒绝|被拒绝|拒绝前|拒绝后"
    r"|\b(?:pending\s+approval|pending\s+review|not\s+approved|unapproved|approver|approval\s+status|approval\s+record|rejection\s+reason|rejected)\b",
    re.IGNORECASE,
)
INQUIRY_RE = re.compile(
    r"[?？]|有哪些|有什么|有多少|几条|哪几条|哪条|哪个|什么|为什么|为啥|怎么|如何"
    r"|能否|是否|是不是|能不能|可不可以|行不行|好不好|对不对|该不该|要不要"
    r"|(?:吗|呢|么)(?:$|[，,。！!？?\s])"
    r"|查看|看看|看一下|查一下|核对|了解|解释|分析|评估|帮我看|给我看|先看|预览"
    r"|确认卡|复述卡|出卡|生成卡|别直接|不要直接|先不直接|不直接|不要直批|别直批"
    r"|\b(?:what|which|how\s+many|why|how|whether"
    r"|can\s+(?:i|you|we)|could\s+(?:i|you|we)|would\s+(?:i|you|we)|should\s+(?:i|we)|shall\s+(?:i|we)|may\s+i"
    r"|do\s+(?:i|we|you)|did\s+(?:i|we|you|he|she|they)|is\s+(?:it|this|that|there)|are\s+(?:we|they|there)"
    r"|show\s+me|tell\s+me|explain|summarize|summary|details|check|view|preview|inspect|look\s+at"
    r"|let\s+me\s+(?:see|check|know|review|confirm)"
    r"|(?:confirmation|review|approval)\s+card|(?:send|show|create|generate|make|give\s+me)\s+a\s+card"
    r"|confirm\s+first|ask\s+me|do\s+not\s+directly|don't\s+directly|not\s+directly|without\s+submitting)\b"
    r"|,\s*(?:right|correct|ok|okay|huh|shall\s+we)\s*$|\bor\s+(?:not|what|no)\s*$",
    re.IGNORECASE,
)
NEGATION_RE = re.compile(
    r"(?:先|暂|暂时)?[不没未非](?:予|要|能|想|打算|准备|会|该|应|应该|可以|允许|太)?(?:批准|批|同意|通过|拒绝|驳回|退回|直接|提交|执行)"
    r"|(?:不是|并非|绝非)(?:要|想|让你)?(?:批准|同意|拒绝|直接)"
    r"|(?:无法|不能)(?:批准|同意|通过|拒绝|直接)"
    r"|(?:^|[，,;；\s先再请])别(?:批准|批|拒绝|驳回|退回|同意|通过|直接|提交|执行)"
    r"|切勿|勿(?:批准|同意|拒绝|直接)"
    r"|\b(?:don't|do\s+not|didn't|did\s+not|won't|will\s+not|wouldn't|would\s+not"
    r"|shouldn't|should\s+not|couldn't|could\s+not|cannot|can't|can\s+not"
    r"|mustn't|must\s+not|haven't|have\s+not|hasn't|has\s+not"
    r"|isn't|is\s+not|aren't|are\s+not|not|never|no\s+longer)\b"
    r"(?:\s+\S+){0,4}\s+(?:(?:auto-?)?(?:approv(?:e|ing|ed)|reject(?:ing|ed)?|declin(?:e|ing|ed)|den(?:y|ying|ied))|submit(?:ting)?|execute|directly)\b"
    r"|\b(?:avoid|stop|cancel|refuse\s+to|decline\s+to|unable\s+to|not\s+ready\s+to|hold\s+off(?:\s+on)?|defer|postpone|delay|without)\b"
    r"(?:\s+\S+){0,3}\s+(?:(?:auto-?)?(?:approv(?:e|ing)|reject(?:ing)?|declin(?:e|ing)|den(?:y|ying))|submit(?:ting)?)\b"
    r"|\b(?:hold\s+on|wait(?:\s+a\s+(?:sec|second|moment|minute))?|not\s+yet|not\s+now)\b",
    re.IGNORECASE,
)
ATTRIBUTION_OR_CONDITIONAL_RE = re.compile(
    r"引用|原文|转述|截图里|附件里|材料里|说明里|文档里|记录里|历史里|上轮|上次"
    r"|提到|声称|写着|写了|(?<!我)说(?!明)"
    r"|(?:希望|想让|让我|叫我|催我|申请|(?<![的条该此])请求).{0,8}(?:批准|同意|通过)"
    r"|如果|假如|假设|要是|倘若|万一|一旦|只要|除非|的话"
    r"|(?:批准|拒绝)(?:之后|以后)"
    r"|(?:考虑|打算|准备|可能|或许|大概|建议)(?:要|去)?(?:批准|同意|拒绝|驳回|退回)"
    r"|再(?:批准|拒绝)"
    r"|\b(?:quoted|quote|attachment|screenshot|document|history|last\s+turn|mentioned|claimed|wrote"
    r"|said|says|saying|told|tells|telling|asked|asks|asking|requested|according\s+to"
    r"|wants?\s+(?:me|us|you)\s+to|wants?\s+to|wanted\s+to|(?:'d|would)\s+like\s+to"
    r"|if|suppose|supposing|assuming|assume|unless|once|when|whenever|provided\s+that|as\s+long\s+as|in\s+case|depending\s+on|depends\s+on"
    r"|after\s+(?:approving|rejecting|declining|denying|checking|reviewing)|before\s+(?:approving|rejecting|declining|denying)"
    r"|consider(?:s|ing)?|plan(?:s|ning)?\s+to|intend(?:s|ing)?\s+to|expect(?:s|ing)?\s+to|aim(?:s|ing)?\s+to|hop(?:e|es|ing)\s+to"
    r"|suggest(?:s|ed|ing)?|recommend(?:s|ed|ing)?|propos(?:e|ed|ing)"
    r"|might|could|would|should|maybe|perhaps|probably|possibly|likely|seem(?:s)?|appear(?:s)?|think(?:ing)?|inclined|leaning|tentative(?:ly)?|not\s+sure|unsure|uncertain|guess|wonder(?:ing)?|hesitat(?:e|ing)"
    r"|(?:am|are|is|'m|'re|'s)\s+going\s+to|gonna"
    r"|tomorrow|later|soon|next\s+(?:week|month|day|sprint|quarter|time)|eventually|afterwards"
    r"|already\s+(?:approved|rejected|declined|denied)|(?:was|were)\s+(?:approved|rejected|declined|denied)"
    r"|(?:i|we|you|he|she|they)'d|(?:i|we|you|he|she|they|it|this|that)'ll"
    r"|(?:i|we|you|he|she|they|it|this|that)\s+(?:may|will)|(?:may|will)\s+(?:be|approve|reject|decline|deny|need|want|consider|wait)"
    r")\b",
    re.IGNORECASE,
)
CHINESE_APPROVE_VERB_RE = re.compile(
    r"批准|审批通过|予以通过|准予通过|同意通过|批准通过|(?:^|[，,;；\s我请帮])同意"
)
ENGLISH_APPROVE_VERB_RE = re.compile(
    r"\bapprove\b|\bi(?:'m|\s+am)\s+approving\b",
    re.IGNORECASE,
)
APPROVE_VERB_RE = re.compile(
    rf"{CHINESE_APPROVE_VERB_RE.pattern}|{ENGLISH_APPROVE_VERB_RE.pattern}",
    re.IGNORECASE,
)
CHINESE_REJECT_VERB_RE = re.compile(r"拒绝|驳回|退回")
ENGLISH_REJECT_VERB_RE = re.compile(
    r"\b(?:reject|decline|deny)\b|\bi(?:'m|\s+am)\s+(?:rejecting|declining|denying)\b",
    re.IGNORECASE,
)
REJECT_VERB_RE = re.compile(
    rf"{CHINESE_REJECT_VERB_RE.pattern}|{ENGLISH_REJECT_VERB_RE.pattern}",
    re.IGNORECASE,
)
_ENGLISH_EXPLICIT_DECISION_RE = re.compile(
    r"^\s*"
    r"(?:(?:yes|ok|okay|sure|alright)\b[\s,，.!！]*)?"
    r"(?:"
    r"(?:(?:please|kindly|just|go\s+ahead(?:\s+and)?)\b[\s,，]*)*"
    r"(?:approve|reject|decline|deny)"
    r"|"
    r"i\s+(?:hereby\s+)?(?:approve|reject|decline|deny)"
    r"|"
    r"i(?:'m|\s+am)\s+(?:approving|rejecting|declining|denying)"
    r")"
    r"(?:\b|$)"
    r"(?P<tail>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_EN_HEAD_NOUN_RE = r"(?:request|submission|change|update|item)"
_EN_MODIFIER_PREFIX_RE = (
    r"(?:(?:the|this|that)\s+)?"
    r"(?:(?:pending|current)\s+)?"
    r"(?:(?:profile|capability)\s+)?"
    r"(?:(?:change|update|review)\s+)?"
)
_EN_ANAPHORA_TARGET_RE = re.compile(
    rf"^(?:this|that|it|this\s+one|that\s+one|the\s+one|{_EN_MODIFIER_PREFIX_RE}{_EN_HEAD_NOUN_RE})$",
    re.IGNORECASE,
)
_EN_UUID_TARGET_RE = re.compile(
    r"^(?:(?:the|this|that)\s+)?(?:(?:change\s+)?request\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_EN_COMMAND_SUFFIX_RE = re.compile(
    r"(?:[\s,，]*(?:now|right\s+now|immediately|directly|please|thanks|thank\s+you))*[\s.,!，。！]*$",
    re.IGNORECASE,
)
_EN_NAMED_FRAME_RE = re.compile(
    rf"^(?:"
    rf"(?:(?:the|this|that)\s+)?(?:(?:'s|’s)\s+)?{_EN_MODIFIER_PREFIX_RE}{_EN_HEAD_NOUN_RE}(?:\s+(?:for|from|of|by)\s+(?:(?:'s|’s)\s*)?)?"
    rf"|(?:(?:the|this|that)\s+)?(?:for|from|of|by)\s+"
    rf"|(?:'s|’s)"
    rf"|(?:的(?:画像|能力|更新|变更|修改)?(?:请求|申请)|那条|这条)"
    rf")$",
    re.IGNORECASE,
)
_EN_NAME_TOKEN_RE = r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff]*"
_EN_SIMPLE_NAME_RE = rf"{_EN_NAME_TOKEN_RE}(?:\s+{_EN_NAME_TOKEN_RE}){{0,2}}"
_EN_OFFLINE_TARGET_RE = re.compile(
    rf"^(?:"
    rf"(?:the\s+)?(?P<s1>{_EN_SIMPLE_NAME_RE})(?:'s|’s)\s+(?:(?P<s2>{_EN_SIMPLE_NAME_RE})\s+)?{_EN_MODIFIER_PREFIX_RE}{_EN_HEAD_NOUN_RE}"
    rf"|(?:(?:the|this|that)\s+)?(?P<s3>{_EN_SIMPLE_NAME_RE})\s+{_EN_MODIFIER_PREFIX_RE}{_EN_HEAD_NOUN_RE}"
    rf"|{_EN_MODIFIER_PREFIX_RE}{_EN_HEAD_NOUN_RE}\s+(?:for|from|of|by)\s+(?P<s4>{_EN_SIMPLE_NAME_RE})(?:(?:'s|’s)\s+(?P<s5>{_EN_SIMPLE_NAME_RE}))?"
    rf"|(?:the\s+)?(?P<s6>{_EN_SIMPLE_NAME_RE})(?:'s|’s|的(?:画像|能力|更新|变更|修改)?(?:请求|申请))?"
    rf")$",
    re.IGNORECASE,
)
_EN_OFFLINE_NON_NAME_WORD_RE = re.compile(
    r"\b(?:pending|final|review|after|before|until|unless|when|while|once|if"
    r"|subject|conditional|contingent|awaiting|following|provided"
    r"|confirm|confirmation|verify|verification|check|later|tomorrow|soon"
    r"|for|with|without|because|since|due|to|and|or|but|button|dialog|modal|page|screen|bug|error|issue)\b",
    re.IGNORECASE,
)
_DEFERRAL_OR_PREREQ_RE = re.compile(
    r"\b(?:pending|awaiting|subject\s+to|contingent|conditional|after|before|until|unless|when|once|for\s+now|to\s+be\s+confirmed|following)\b"
    r"|有待|等待|复核后|确认后",
    re.IGNORECASE,
)
_REASON_DIRECTIVE_RE = re.compile(
    r"[?？]"
    r"|确认卡|复述卡|出卡|生成卡|别直接|不要直接|先不直接|不直接"
    r"|\b(?:(?:confirmation|review|approval)\s+card|(?:send|show|create|generate|make|give\s+me)\s+a\s+card"
    r"|confirm\s+first|do\s+not\s+directly|don't\s+directly|not\s+directly|without\s+submitting)\b"
    r"|\b(?:don't|do\s+not|not|never|cannot|can't|won't|wouldn't|shouldn't|avoid|stop|cancel|hold\s+off|defer|postpone|delay)\b"
    r"(?:\s+\S+){0,3}\s+(?:reject(?:ing)?|declin(?:e|ing)|den(?:y|ying)|submit(?:ting)?|execute|send(?:ing)?|directly)\b"
    r"|\b(?:hold\s+on|hold\s+off|wait(?:\s+(?:a\s+\S+|for|until|before))?|not\s+yet|not\s+now)\b"
    r"|(?:先|暂|暂时)?[不没未别勿](?:要|予|能|直接)?(?:拒绝|驳回|退回|提交|执行|发送|直接)"
    r"|\b(?:(?:pending|awaiting|subject\s+to|contingent\s+on|conditional\s+on)\s+(?:final\s+|my\s+|our\s+|further\s+|manager\s+)?(?:review|confirmation|approval|check|verification|sign-off)"
    r"|(?:after|before|until|once|when)\s+(?:i|we|you|manager)\s+(?:review|check|confirm|verify|approve|reject|decide)"
    r"|(?:after|before)\s+(?:my|our|final)\s+(?:review|check|confirmation|verification)"
    r"|until\s+(?:confirmed|verified|reviewed|final\s+review)"
    r"|for\s+now|to\s+be\s+confirmed|unless)\b"
    r"|有待(?:最终)?(?:复核|确认|审批)|(?:等我|待我|经我)(?:复核|确认|核实)(?:后|之后|后再)?|确认后再(?:执行|提交|拒绝)",
    re.IGNORECASE,
)
POST_REASON_COLON_RE = re.compile(
    r"^(?P<decision>.+?)[，,;；。\s（(]*(?:(?:拒绝|驳回|退回)?(?:原因|理由|说明)\s*(?:为|是)?|(?:reject(?:ion)?\s+)?reason(?:\s+is)?)\s*[:：]\s*(?P<reason>.+)$",
    re.IGNORECASE,
)
POST_REASON_WORD_RE = re.compile(
    r"^(?P<decision>.+?)[，,;；。\s]+(?:(?:拒绝|驳回|退回)?(?:原因|理由|说明)\s*(?:为|是)|因为|由于|(?:reject(?:ion)?\s+)?reason\s*(?:is)?|because(?:\s+of)?|due\s+to)\s*[:：]?\s*(?P<reason>.+)$",
    re.IGNORECASE,
)
PRE_REASON_RE = re.compile(
    r"^(?:因为|由于|because(?:\s+of)?|due\s+to|since)\s*(?P<reason>[^，,;；。\n]+)[，,;；。\s]+(?P<decision>.+)$",
    re.IGNORECASE,
)
TARGET_COLON_RE = re.compile(r"^(?P<decision>[^:：]+)[:：]\s*(?P<reason>.+)$")
NON_REASON_VALUES = {
    "无",
    "没有",
    "暂无",
    "不需要",
    "不用",
    "谢谢",
    "感谢",
    "麻烦了",
    "请处理",
    "辛苦",
    "辛苦了",
    "好的",
    "好",
    "行",
    "可以",
    "none",
    "n/a",
    "na",
    "no",
    "nothing",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "please",
}
NORM_PUNCT_RE = re.compile(r"[\s，,。；;：:！!？?、（）()\"'“”‘’「」『』`.]+")
REASON_LABEL_PREFIX_RE = re.compile(
    r"^\s*(?:(?:拒绝|驳回|退回)?(?:原因|理由|说明)\s*(?:(?:为|是)\s*[:：]?|[:：])\s*|(?:因为|由于)\s*[:：]?\s*|(?:reject(?:ion)?\s+)?reason\s*(?:is\s*)?[:：]?\s*|(?:because(?:\s+of)?|due\s+to)\s*[:：]?\s*)",
    re.IGNORECASE,
)
TARGET_SUBJECT_RE = re.compile(
    r"(?:批准|同意|拒绝|驳回|退回)\s*([^，,。；;：:\n]{1,30}?)(?:的(?:画像|能力|更新|变更|修改)?(?:请求|申请)|那条|这条)"
)
_ENGLISH_TARGET_SUBJECT_RE = re.compile(
    r"\b(?:approve|reject|decline|deny|approving|rejecting|declining|denying)\s+"
    r"(?P<subject>[^,.;:!\?\n]{1,60}?)\s+"
    r"(?:profile\s+|capability\s+|change\s+|update\s+)*(?:request|submission|change|update|item)\b",
    re.IGNORECASE,
)
_ENGLISH_GENERIC_SUBJECT_RE = re.compile(
    r"(?:'s|’s)(?:\b|$)"
    r"|\b(?:the|this|that|a|an|one|only|current|pending|above|previous|last"
    r"|profile|capability|change|update|review|approval|request|employee|staff|member"
    r"|his|her|their|its)\b",
    re.IGNORECASE,
)
GENERIC_SUBJECT_TOKENS = {
    "这",
    "那",
    "该",
    "此",
    "他",
    "她",
    "它",
    "对方",
    "员工",
    "本人",
    "下属",
    "该员工",
    "待审批",
    "待审",
    "当前",
    "唯一",
    "上面",
    "刚才",
    "这条",
    "那条",
    "这个",
    "那个",
    "请求",
    "申请",
    "修改",
    "更新",
    "变更",
    "能力",
    "画像",
    "提交",
    "的",
    "把",
    "将",
    "对",
}


class PrepareInput(DecideInput):
    request_id: UUID
    # Decisions and their reasons are repeated on the card; no hidden overall comment.
    comment: None = None
    direct: StrictBool = False


INPUTS: dict[str, type[ToolInput]] = {
    "list_pending_reviews": ToolInput,
    "get_review": RequestInput,
    "prepare_review_decision": PrepareInput,
}


def definitions() -> list[ToolDefinition]:
    descriptions = {
        "list_pending_reviews": "查看本人有权审批的请求；不能审批自己的请求。",
        "get_review": "查看审批改动前后、依据与不确定之处，取得决定时必填的 revision；不能审批自己的请求。",
        "prepare_review_decision": "校验审批决定；默认（direct=false）仅生成审批决定复述确认卡，经理点击确认决定后才生效。"
        "仅当经理在对话中对唯一一条明确指向的请求明确说「批准」，或说「拒绝」并给出原因时，才可设 direct=true 直接提交决定；"
        "若涉及多条请求、批量审批、指向不明确或缺少拒绝原因，禁止设 direct=true，必须用 direct=false 出确认卡或先追问。拒绝必须有经理给的原因；不能审批自己的请求。",
    }
    return [
        ToolDefinition(
            name=name,
            description=descriptions[name],
            parameters=model.model_json_schema(),
        )
        for name, model in INPUTS.items()
    ]


def _clean_reason(raw: str | None, target_names: set[str]) -> str | None:
    if not raw:
        return None
    cleaned = raw.strip()
    if cleaned.endswith(("）", ")")) and "（" not in cleaned and "(" not in cleaned:
        cleaned = cleaned[:-1].strip()
    cleaned = re.sub(
        r"[，,。\s]*(?:谢谢|感谢|麻烦了|辛苦了?|thanks|thank\s+you|please)[！!。.\s]*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = cleaned.strip(" \t\r\n，,。；;！!.")
    if not cleaned or cleaned.casefold() in NON_REASON_VALUES:
        return None
    remainder = cleaned
    for name in sorted(target_names, key=len, reverse=True):
        if name:
            remainder = remainder.replace(name, "")
    remainder = re.sub(
        r"拒绝|驳回|退回|这条|那条|这个|那个|该条|该请求|此请求|请求|申请|修改|能力|请|帮我|直接|的|了|吧|啊|呢|\b(?:reject|decline|deny|this|that|request|capability|please|directly|the|a|an)\b",
        "",
        remainder,
        flags=re.IGNORECASE,
    )
    remainder = NORM_PUNCT_RE.sub("", remainder)
    if len(remainder) <= 1:
        return None
    return cleaned


def _split_decision_and_reason(
    turn_text: str, target_names: set[str]
) -> tuple[str, str | None]:
    text = turn_text.strip()
    for pattern in (POST_REASON_COLON_RE, POST_REASON_WORD_RE):
        if match := pattern.match(text):
            decision = match.group("decision").rstrip("（( \t")
            reason = match.group("reason").strip()
            unquoted = QUOTED_RE.sub(" ", decision)
            if REJECT_VERB_RE.search(COMPOUND_NOUN_RE.sub(" ", unquoted)):
                return decision, reason
    if match := PRE_REASON_RE.match(text):
        decision = match.group("decision").strip()
        reason = match.group("reason").strip()
        if REJECT_VERB_RE.search(
            COMPOUND_NOUN_RE.sub(" ", QUOTED_RE.sub(" ", decision))
        ):
            return decision, reason
    if match := TARGET_COLON_RE.match(text):
        decision = match.group("decision").strip()
        reason = match.group("reason").strip()
        unquoted = QUOTED_RE.sub(" ", decision)
        if REJECT_VERB_RE.search(
            COMPOUND_NOUN_RE.sub(" ", unquoted)
        ) and not ATTRIBUTION_OR_CONDITIONAL_RE.search(unquoted):
            return decision, reason
    clauses = [
        c.strip() for c in re.split(r"(?:[，,;；。\n]|\.(?=\s|$))+", text) if c.strip()
    ]
    if len(clauses) >= 2:
        reject_clauses = [
            c
            for c in clauses
            if REJECT_VERB_RE.search(COMPOUND_NOUN_RE.sub(" ", QUOTED_RE.sub(" ", c)))
        ]
        other_clauses = [c for c in clauses if c not in reject_clauses]
        if reject_clauses and other_clauses:
            candidate_reason = "，".join(other_clauses)
            # Keep inquiry/conditional/batch clauses in decision_part so guards catch them.
            if (
                not INQUIRY_RE.search(candidate_reason)
                and not ATTRIBUTION_OR_CONDITIONAL_RE.search(candidate_reason)
                and not NEGATION_RE.search(candidate_reason)
                and not _DEFERRAL_OR_PREREQ_RE.search(candidate_reason)
                and not _has_batch_pattern(candidate_reason)
                and _clean_reason(candidate_reason, target_names) is not None
            ):
                return "，".join(reject_clauses), candidate_reason
    return text, None


def _is_explicit_english_decision(decision_part: str, target_names: set[str]) -> bool:
    known_names = [name for name in sorted(target_names, key=len, reverse=True) if name]
    known_folded = {name.casefold() for name in known_names}
    normalized = decision_part
    if QUOTED_RE.search(normalized):
        if not known_folded:
            return False

        def _unwrap_known_quote(match: re.Match[str]) -> str:
            inner = match.group(0)[1:-1].strip()
            return inner if inner.casefold() in known_folded else match.group(0)

        normalized = QUOTED_RE.sub(_unwrap_known_quote, normalized)
        if QUOTED_RE.search(normalized):
            return False

    cmd_match = _ENGLISH_EXPLICIT_DECISION_RE.match(normalized)
    if not cmd_match:
        return False
    target_text = _EN_COMMAND_SUFFIX_RE.sub("", cmd_match.group("tail")).strip()
    if not target_text:
        return True
    if _EN_ANAPHORA_TARGET_RE.fullmatch(target_text) or _EN_UUID_TARGET_RE.fullmatch(
        target_text
    ):
        return True
    if known_names:
        remaining = target_text
        for name in known_names:
            prefix = (
                r"(?<![A-Za-z0-9])" if name[0].isascii() and name[0].isalnum() else ""
            )
            suffix = (
                r"(?![A-Za-z0-9])" if name[-1].isascii() and name[-1].isalnum() else ""
            )
            remaining = re.sub(
                f"{prefix}{re.escape(name)}{suffix}",
                " ",
                remaining,
                flags=re.IGNORECASE,
            )
        remaining = " ".join(remaining.split())
        if not remaining:
            return True
        return remaining != target_text and bool(
            _EN_NAMED_FRAME_RE.fullmatch(remaining)
        )

    offline_match = _EN_OFFLINE_TARGET_RE.fullmatch(target_text)
    if not offline_match:
        return False
    return not any(
        val and _EN_OFFLINE_NON_NAME_WORD_RE.search(val)
        for val in offline_match.groupdict().values()
    )


def _has_reason_condition_or_deferral(raw_reason: str) -> bool:
    unquoted = QUOTED_RE.sub(" ", raw_reason)
    if _has_batch_pattern(unquoted) or _REASON_DIRECTIVE_RE.search(unquoted):
        return True
    sentences = [
        s.strip() for s in re.split(r"(?:[。\n;；]|\.(?=\s|$))+", unquoted) if s.strip()
    ]
    for extra_sentence in sentences[1:]:
        verb_scan = COMPOUND_NOUN_RE.sub(" ", extra_sentence)
        if (
            INQUIRY_RE.search(extra_sentence)
            or NEGATION_RE.search(extra_sentence)
            or ATTRIBUTION_OR_CONDITIONAL_RE.search(extra_sentence)
            or _DEFERRAL_OR_PREREQ_RE.search(extra_sentence)
            or APPROVE_VERB_RE.search(verb_scan)
            or REJECT_VERB_RE.search(verb_scan)
        ):
            return True
    for sentence in sentences:
        clauses = [c.strip() for c in re.split(r"[，,]+", sentence) if c.strip()]
        for extra_clause in clauses[1:]:
            if re.search(
                r"\b(?:pending|awaiting|conditional|contingent)\b",
                extra_clause,
                re.IGNORECASE,
            ):
                return True
    return False


def _has_batch_pattern(text: str) -> bool:
    return any(token in text for token in BATCH_PATTERNS) or bool(
        _ENGLISH_BATCH_RE.search(text)
    )


def _parse_turn_decision(
    turn_text: str, target_names: set[str]
) -> tuple[ItemDecision, str | None, str] | str:
    decision_part, raw_reason = _split_decision_and_reason(turn_text, target_names)
    if _has_batch_pattern(decision_part):
        return tr(
            "一句话涉及多条请求或批量审批，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
        )
    if INQUIRY_RE.search(decision_part):
        return tr(
            "当前消息为查询、询问或预览要求，请仅回复查询结果或改用 direct=false 调用 prepare_review_decision 生成确认卡"
        )
    if NEGATION_RE.search(decision_part):
        return tr(
            "当前消息包含否定或暂缓意思，禁止直接提交；请追问经理或改用 direct=false 生成确认卡"
        )
    unquoted = QUOTED_RE.sub(" ", decision_part)
    if ATTRIBUTION_OR_CONDITIONAL_RE.search(unquoted):
        return tr(
            "当前消息包含引用、转述或条件假设，未能确认经理本轮直接决定；请改用 direct=false 生成确认卡或追问"
        )
    verb_scan = COMPOUND_NOUN_RE.sub(" ", unquoted)
    has_zh_approve = bool(CHINESE_APPROVE_VERB_RE.search(verb_scan))
    has_zh_reject = bool(CHINESE_REJECT_VERB_RE.search(verb_scan))
    has_approve = has_zh_approve or bool(ENGLISH_APPROVE_VERB_RE.search(verb_scan))
    has_reject = has_zh_reject or bool(ENGLISH_REJECT_VERB_RE.search(verb_scan))
    if has_approve and has_reject:
        return tr(
            "同一轮同时包含批准与拒绝或逐项混合决定，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
        )
    if not has_approve and not has_reject:
        return tr(
            "未在经理本轮消息中确认明确的「批准」或「拒绝」决定，请先追问或改用 direct=false 生成确认卡"
        )
    if not has_zh_approve and not has_zh_reject:
        if not _is_explicit_english_decision(decision_part, target_names):
            return tr(
                "未在经理本轮消息中确认明确的「批准」或「拒绝」决定，请先追问或改用 direct=false 生成确认卡"
            )
    if has_approve:
        return ItemDecision.APPROVED, None, decision_part
    reason = _clean_reason(raw_reason, target_names)
    if not reason:
        return tr(
            "拒绝必须由经理在本轮明确说明原因，请追问经理原因或改用 direct=false 生成确认卡"
        )
    assert raw_reason is not None
    if _has_reason_condition_or_deferral(raw_reason):
        return tr(
            "当前消息包含引用、转述或条件假设，未能确认经理本轮直接决定；请改用 direct=false 生成确认卡或追问"
        )
    return ItemDecision.REJECTED, reason, decision_part


def _normalize_reason(text: str) -> str:
    stripped = REASON_LABEL_PREFIX_RE.sub("", text.strip())
    return NORM_PUNCT_RE.sub("", stripped)


def _reasons_match(submitted: str, extracted: str) -> bool:
    norm_arg = _normalize_reason(submitted)
    norm_ext = _normalize_reason(extracted)
    return bool(norm_arg and norm_ext and norm_arg == norm_ext)


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _uniquely_identifies(
    text: str,
    request_id: UUID,
    target: ReviewSummary,
    pending_list: list[ReviewSummary],
    caps_by_req: dict[UUID, set[str]],
    *,
    allow_employee: bool = True,
) -> bool:
    if str(request_id) in text:
        return True
    if allow_employee:
        same_employee_count = sum(
            1 for r in pending_list if r.employee_name == target.employee_name
        )
        if same_employee_count == 1 and target.employee_name in text:
            return True
    other_caps = {
        cap_name
        for req_id, names in caps_by_req.items()
        if req_id != request_id
        for cap_name in names
    }
    unique_caps = caps_by_req.get(request_id, set()) - other_caps
    return any(cap_name in text for cap_name in unique_caps)


def _mentions_other_target(
    text: str,
    request_id: UUID,
    target: ReviewSummary,
    target_caps: set[str],
    other_employees: set[str],
    all_other_caps: set[str],
) -> str | None:
    if any(uid.lower() != str(request_id).lower() for uid in UUID_RE.findall(text)):
        return tr(
            "一句话涉及其他或未知的审批请求，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
        )
    for emp_name in other_employees:
        if (
            len(emp_name) >= 2
            and emp_name != target.employee_name
            and emp_name not in target.employee_name
            and emp_name in text
        ):
            return tr(
                "一句话涉及其他员工或多位员工的请求，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
            )
    for cap_name in all_other_caps:
        if (
            cap_name
            and not any(cap_name in tc for tc in target_caps)
            and cap_name not in target.employee_name
            and cap_name in text
        ):
            return tr(
                "一句话涉及其他能力或多项请求，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
            )
    for match in TARGET_SUBJECT_RE.finditer(text):
        subject = match.group(1).strip()
        if not subject or str(request_id) in subject:
            continue
        if target.employee_name in subject or any(
            cap_name in subject for cap_name in target_caps
        ):
            continue
        stripped = subject
        for token in sorted(GENERIC_SUBJECT_TOKENS, key=len, reverse=True):
            stripped = stripped.replace(token, "")
        if NORM_PUNCT_RE.sub("", stripped):
            return tr(
                "一句话指向的请求与当前待审批请求不匹配，请先核对对象或改用 direct=false 生成确认卡"
            )
    for match in _ENGLISH_TARGET_SUBJECT_RE.finditer(text):
        subject = match.group("subject").strip()
        if not subject or str(request_id) in subject:
            continue
        lowered_subject = subject.casefold()
        if target.employee_name.casefold() in lowered_subject or any(
            cap_name.casefold() in lowered_subject for cap_name in target_caps
        ):
            continue
        stripped = _ENGLISH_GENERIC_SUBJECT_RE.sub(" ", subject)
        if NORM_PUNCT_RE.sub("", stripped):
            return tr(
                "一句话指向的请求与当前待审批请求不匹配，请先核对对象或改用 direct=false 生成确认卡"
            )
    return None


def _prior_messages(
    db: Session, session: BotSession, turn_text: str
) -> list[store.MessagePublic]:
    messages = store.messages_for(db, session)
    if (
        messages
        and messages[-1].role == "user"
        and isinstance(messages[-1].payload, dict)
        and messages[-1].payload.get("text") == turn_text
    ):
        messages = messages[:-1]
    return messages


def _card_matches_target(
    card: s.ReviewCard,
    request_id: UUID,
    revision: int,
    confirmed_card_ids: set[str],
) -> bool:
    return (
        card.id == request_id
        and card.revision == revision
        and card.status == "pending"
        and bool(card.actions)
        and str(card.card_id) not in confirmed_card_ids
    )


def _assess_session_context(
    db: Session,
    session: BotSession,
    pending_list: list[ReviewSummary],
    target: ReviewSummary,
    revision: int,
    turn_text: str,
    caps_by_req: dict[UUID, set[str]],
    other_employees: set[str],
    all_other_caps: set[str],
) -> tuple[bool, bool]:
    """Return (matches_anaphora, has_conflict_or_stale) for prior session context."""
    messages = _prior_messages(db, session, turn_text)
    if not messages:
        return False, False
    confirmed_ids = {
        cid
        for m in messages
        if m.role == "assistant"
        and isinstance(m.payload, dict)
        and isinstance((cid := m.payload.get("confirmed_card_id")), str)
    }
    last_assistant = next(
        (m for m in reversed(messages) if m.role == "assistant"), None
    )
    step_conflict = False
    if last_assistant and isinstance(last_assistant.payload, dict):
        if "confirmed_card_id" in last_assistant.payload:
            return False, True
        parsed = s.TurnResponse.model_validate(last_assistant.payload)
        review_cards = [m for m in parsed.messages if isinstance(m, s.ReviewCard)]
        if review_cards:
            matched = len(review_cards) == 1 and _card_matches_target(
                review_cards[0], target.id, revision, confirmed_ids
            )
            return matched, not matched
        step_names = {step.name for step in parsed.steps}
        get_review_names = {
            "查看审批详情",
            EN_CATALOG.get("查看审批详情", "查看审批详情"),
        }
        decide_names = {"审批决定", EN_CATALOG.get("审批决定", "审批决定")}
        if step_names and not any(
            step.name in get_review_names and step.ok for step in parsed.steps
        ):
            step_conflict = True
        if any(step.name in decide_names and step.ok for step in parsed.steps):
            step_conflict = True
    if step_conflict:
        return False, True
    last_user = next((m for m in reversed(messages) if m.role == "user"), None)
    if last_user and isinstance(last_user.payload, dict):
        prev_text = last_user.payload.get("text")
        if isinstance(prev_text, str):
            target_caps = caps_by_req.get(target.id, set())
            user_mismatch = _has_batch_pattern(prev_text) or bool(
                _mentions_other_target(
                    prev_text,
                    target.id,
                    target,
                    target_caps,
                    other_employees,
                    all_other_caps,
                )
            )
            if user_mismatch:
                return False, True
            user_identifies = _uniquely_identifies(
                prev_text, target.id, target, pending_list, caps_by_req
            )
            if target.submitted_at is not None and _utc(last_user.created_at) < _utc(
                target.submitted_at
            ):
                lowered_prev = prev_text.casefold()
                stale_ref = user_identifies or any(
                    kw in lowered_prev
                    for kw in (
                        "请求",
                        "申请",
                        "审批",
                        "批准",
                        "拒绝",
                        "驳回",
                        "退回",
                        "修改",
                        "request",
                        "review",
                        "approve",
                        "reject",
                        "modify",
                        "update",
                    )
                )
                return False, stale_ref
            return user_identifies, False
    return False, False


def _authorize_direct_decision(
    db: Session,
    p: Principal,
    session: BotSession,
    body: PrepareInput,
    turn_text: str | None,
    decided_review_ids: list[UUID] | None,
) -> tuple[list[DecisionInput] | None, str | None]:
    if decided_review_ids:
        return (
            None,
            tr(
                "单轮对话只能直接提交一条明确指定的审批请求；涉及多条请求或批量审批请改用 direct=false 调用 prepare_review_decision 生成确认卡"
            ),
        )
    if not turn_text or not turn_text.strip():
        return (
            None,
            tr(
                "缺少经理本轮明确决定，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
            ),
        )

    pending_list = manager_tools.list_pending_reviews(p, db).data
    target = next((r for r in pending_list if r.id == body.request_id), None)
    if target is None:
        return None, tr("内容已更新，请刷新查看")

    cap_rows = db.exec(
        select(ChangeItem.request_id, CapabilityDefinition.name)
        .join(
            CapabilityDefinition,
            (col(CapabilityDefinition.id) == ChangeItem.capability_definition_id)
            & (col(CapabilityDefinition.org_id) == ChangeItem.org_id),
        )
        .where(
            ChangeItem.org_id == p.org_id,
            col(ChangeItem.request_id).in_([r.id for r in pending_list]),
            col(ChangeItem.decision).is_(None),
        )
    ).all()
    caps_by_req: dict[UUID, set[str]] = {}
    for req_id, cap_name in cap_rows:
        caps_by_req.setdefault(req_id, set()).add(cap_name)
    target_caps = caps_by_req.get(body.request_id, set())
    target_names = {target.employee_name, *target_caps}

    parsed = _parse_turn_decision(turn_text, target_names)
    if isinstance(parsed, str):
        return None, parsed
    expected_decision, expected_reason, decision_part = parsed

    if any(d.decision != expected_decision for d in body.decisions):
        return (
            None,
            tr(
                "模型提交的审批决定与经理本轮明确表达不一致，请改用 direct=false 调用 prepare_review_decision 生成确认卡"
            ),
        )
    if expected_decision == ItemDecision.REJECTED:
        assert expected_reason is not None
        if any(
            not _reasons_match(d.reason or "", expected_reason) for d in body.decisions
        ):
            return (
                None,
                tr(
                    "模型提交的拒绝理由与经理本轮说明不一致，请按经理原话填写或改用 direct=false 生成确认卡"
                ),
            )

    other_employees = set(
        db.exec(
            select(Employee.display_name).where(
                Employee.org_id == p.org_id,
                Employee.employment_status == EmploymentStatus.ACTIVE,
            )
        ).all()
    )
    active_caps = set(
        db.exec(
            select(CapabilityDefinition.name)
            .join(
                CapabilitySchemaVersion,
                (
                    col(CapabilitySchemaVersion.id)
                    == CapabilityDefinition.schema_version_id
                )
                & (col(CapabilitySchemaVersion.org_id) == CapabilityDefinition.org_id),
            )
            .where(
                CapabilityDefinition.org_id == p.org_id,
                CapabilitySchemaVersion.status == SchemaStatus.ACTIVE,
            )
        ).all()
    )
    all_other_caps = (
        active_caps | {c for names in caps_by_req.values() for c in names}
    ) - target_caps
    if mismatch_err := _mentions_other_target(
        decision_part,
        body.request_id,
        target,
        target_caps,
        other_employees,
        all_other_caps,
    ):
        return None, mismatch_err

    matches_anaphora, has_conflict = _assess_session_context(
        db,
        session,
        pending_list,
        target,
        body.revision,
        turn_text,
        caps_by_req,
        other_employees,
        all_other_caps,
    )
    explicitly_identified = _uniquely_identifies(
        decision_part, body.request_id, target, pending_list, caps_by_req
    )
    has_anaphora = any(token in decision_part for token in ANAPHORA_PATTERNS) or bool(
        _ENGLISH_ANAPHORA_RE.search(decision_part)
    )

    if explicitly_identified:
        if (
            has_anaphora
            and has_conflict
            and not _uniquely_identifies(
                decision_part,
                body.request_id,
                target,
                pending_list,
                caps_by_req,
                allow_employee=False,
            )
        ):
            return (
                None,
                tr(
                    "当前会话上下文已失效或指向其他请求，请先确认具体请求或改用 direct=false 生成确认卡"
                ),
            )
    elif not matches_anaphora:
        return (
            None,
            tr(
                "当前审批请求指向不明确或会话上下文已失效，请先确认具体请求或改用 direct=false 生成确认卡"
            ),
        )

    # Persist the server-extracted manager verbatim reason, never model-submitted text.
    validated_decisions = [
        d.model_copy(
            update={
                "reason": expected_reason
                if expected_decision == ItemDecision.REJECTED
                else None
            }
        )
        for d in body.decisions
    ]
    return validated_decisions, None


def call(
    db: Session,
    p: Principal,
    _session: BotSession,
    cards: list[s.Message],
    name: str,
    arguments: dict[str, JsonValue],
    *,
    decided_review_ids: list[UUID] | None = None,
    turn_text: str | None = None,
) -> JsonValue:
    try:
        body = INPUTS[name].model_validate(arguments)
    except ValidationError:
        return {"error": tr("请逐项给出决定，拒绝必须说明原因")}
    if name == "list_pending_reviews":
        rows = manager_tools.list_pending_reviews(p, db)
        names: dict[UUID, list[str]] = {}
        for request_id, capability_name in db.exec(
            select(ChangeItem.request_id, CapabilityDefinition.name)
            .join(
                CapabilityDefinition,
                (col(CapabilityDefinition.id) == ChangeItem.capability_definition_id)
                & (col(CapabilityDefinition.org_id) == ChangeItem.org_id),
            )
            .where(
                ChangeItem.org_id == p.org_id,
                col(ChangeItem.request_id).in_([r.id for r in rows.data]),
                col(ChangeItem.decision).is_(None),
            )
            .order_by(col(ChangeItem.position))
        ).all():
            names.setdefault(request_id, []).append(capability_name)
        return {
            "data": [
                {
                    "id": str(r.id),
                    "item_count": r.item_count,
                    "employee_name": r.employee_name,
                    "department_name": r.department_name,
                    "capabilities": tr("、").join(names.get(r.id, [])[:3])
                    + (
                        tr("等 {count} 项", count=len(names[r.id]))
                        if len(names.get(r.id, [])) > 3
                        else ""
                    ),
                    "submitted_at": r.submitted_at.astimezone(
                        ZoneInfo("Asia/Shanghai")
                    ).isoformat()
                    if r.submitted_at
                    else None,
                }
                for r in rows.data
            ],
            "count": rows.count,
        }
    if isinstance(body, PrepareInput) and body.direct:
        if _session.org_id != p.org_id or _session.employee_id != p.employee_id:
            return {"error": tr("你不是当前审批人，或不能审批本人的请求")}
        try:
            manager_tools._require_reviewer(p, db, body.request_id)
        except EmployeeRecordNotFound, service.ReviewForbidden:
            return {"error": tr("你不是当前审批人，或不能审批本人的请求")}
        validated_decisions, guard_error = _authorize_direct_decision(
            db, p, _session, body, turn_text, decided_review_ids
        )
        if guard_error is not None or validated_decisions is None:
            return {"error": guard_error or tr("无法确认审批决定")}
        try:
            result = manager_tools.decide_review_items(
                p,
                db,
                body.request_id,
                body.revision,
                validated_decisions,
                body.comment,
                via=ReviewVia.BOT,
                client_name=CHANNEL_CLIENTS.get(_session.channel, _session.channel),
            )
        except EmployeeRecordNotFound, service.ReviewForbidden:
            return {"error": tr("你不是当前审批人，或不能审批本人的请求")}
        except RequestConflict as exc:
            return {"error": tr(str(exc.detail))}
        except InvalidItems as exc:
            return {"error": tr("；").join(tr(str(e["message"])) for e in exc.errors)}
        if decided_review_ids is not None:
            decided_review_ids.append(body.request_id)
        return result.model_dump(mode="json")
    assert isinstance(body, (RequestInput, PrepareInput))
    request_id = body.request_id
    try:
        detail = manager_tools.get_review(p, db, request_id)
    except EmployeeRecordNotFound, service.ReviewForbidden:
        return None
    projected = name_levels(db, p, s.Review.model_validate(detail))
    if isinstance(body, PrepareInput):
        if body.revision != detail.revision:
            return {"error": tr("内容已更新，请刷新查看")}
        try:
            service.validate_decisions(detail, body.decisions)
        except InvalidItems as exc:
            return {"error": tr("；").join(tr(str(e["message"])) for e in exc.errors)}
        card = s.ReviewCard(**projected.model_dump(), decisions=body.decisions)
        card.actions = [
            s.ReviewAction(
                action=a,
                request_id=detail.id,
                revision=detail.revision,
                card_id=card.card_id,
            )
            for a in ("confirm_review", "continue_review")
        ]
        cards.append(card)
    return projected.model_dump(mode="json")
