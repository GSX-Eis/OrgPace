from pydantic import JsonValue

from app.core.config import settings
from app.domains.bot import schemas as s
from app.i18n import tr

LABELS = {
    "confirm_capacity": "确认",
    "cancel_capacity": "取消",
    "confirm_profile_edit": "确认修改",
    "continue_profile_edit": "继续修改",
    "confirm_review": "确认决定",
    "continue_review": "继续修改",
    "confirm_submit": "确认提交",
    "continue_editing": "继续修改",
    "withdraw": "撤回",
    "answer_question": "回答",
    "draft": "草稿",
    "pending_owner": "待本人确认",
    "pending_review": "待经理审批",
    "withdrawn": "已撤回",
    "approved": "已批准",
    "rejected": "被拒绝",
    "returned": "被拒绝",
    "changes_requested": "被拒绝",
    "partially_approved": "部分批准",
    "tentative": "暂定",
    "confirmed": "已确认",
    "disputed": "存在争议",
    "unknown": "未知",
    "add": "新增",
    "modify": "修改",
    "retract": "撤销",
    "attach_evidence": "补充依据",
}

FEASIBILITY_CONCLUSIONS = {
    "can_do": "有空承接",
    "later": "稍后可承接",
    "needs_confirmation": "待部门确认",
    "cannot_do": "暂难承接",
}

FEASIBILITY_SOURCES = {
    "confirmed": "已确认排期",
    "forecast_baseline": "预测基线",
    "mixed": "已确认+预测基线",
}


def feasibility_text(card: s.FeasibilityCard) -> str:
    cap = card.allocation_cap_percent
    lines = [
        tr(
            "{capability} · {start} 至 {end} · 常规配额 {cap}% / 弹性空间 {elastic}%",
            capability=card.capability_name,
            start=card.window_start,
            end=card.window_end,
            cap=cap,
            elastic=100 - cap,
        )
    ]
    for row in card.departments:
        if row.load_level == "withheld":
            load = tr("整体负荷暂不展示")
        elif row.load_level == "unknown" or row.department_load_percent is None:
            load = tr("暂无负荷数据")
        else:
            load = tr("整体负荷 {percent}%", percent=row.department_load_percent)
            if (
                row.regular_used_percent is not None
                and row.elastic_used_percent is not None
                and row.regular_headroom_percent is not None
                and row.elastic_headroom_percent is not None
            ):
                load += tr(
                    "（常规配额已用 {reg_used}%/余量 {reg_headroom}% · 弹性空间已用 {el_used}%/余量 {el_headroom}%）",
                    reg_used=row.regular_used_percent,
                    reg_headroom=row.regular_headroom_percent,
                    el_used=row.elastic_used_percent,
                    el_headroom=row.elastic_headroom_percent,
                )
            elif (
                row.regular_headroom_percent is not None
                and row.elastic_headroom_percent is not None
            ):
                load += tr(
                    "（常规余量 {reg_headroom}% · 弹性余量 {el_headroom}%）",
                    reg_headroom=row.regular_headroom_percent,
                    el_headroom=row.elastic_headroom_percent,
                )
        start = row.earliest_start_date or tr(
            {
                "needs_confirmation": "待目标部门确认",
                "cannot_do": "近期暂无空档",
            }.get(row.conclusion, "待排期确认")
        )
        conclusion = tr(FEASIBILITY_CONCLUSIONS[row.conclusion])
        notes: list[str] = []
        if source_label := FEASIBILITY_SOURCES.get(row.data_source):
            notes.append(tr(source_label))
        elif row.is_estimated:
            notes.append(tr("估算参考"))
        if row.exceeds_regular_cap and row.load_level != "withheld":
            notes.append(
                tr(
                    "已突破常规上限（动用弹性 {percent}%）",
                    percent=row.elastic_used_percent or 0,
                )
            )
        if row.needs_elastic and row.load_level != "withheld":
            notes.append(tr("需动用弹性空间"))
        note_text = tr("（{notes}）", notes=tr("，").join(notes)) if notes else ""
        lines.append(
            tr(
                "{department} · {load} · {conclusion}{note_text} · 最早可能开始：{start}",
                department=row.department_name,
                load=load,
                conclusion=conclusion,
                note_text=note_text,
                start=start,
            )
        )
    if any(
        row.data_source in ("forecast_baseline", "mixed")
        or (
            (row.needs_elastic or row.exceeds_regular_cap)
            and row.load_level != "withheld"
        )
        for row in card.departments
    ):
        lines.append(
            tr(
                "提示：预测基线由系统基于历史排期与在途工作自动估算；动用弹性空间需目标部门经理最终确认。"
            )
        )
    return "\n".join(lines)


def claim_text(claim: s.Claim | None) -> str:
    if claim is None:
        return tr("暂无记录")
    status = LABELS.get(claim.assessment_status, claim.assessment_status)
    return tr(
        "{statement}；等级：{level}；状态：{status}",
        statement=claim.statement,
        level=claim.level_name or tr("未定级"),
        status=tr(status),
    )


def item_text(item: s.ChangeItem) -> str:
    lines = [
        tr(
            "{capability}：{op}",
            capability=item.capability.name,
            op=tr(LABELS.get(item.op, item.op)),
        ),
        tr(
            "{statement}；等级：{level}",
            statement=item.after.statement,
            level=item.after.level_name or tr("未定级"),
        )
        if item.after
        else tr("撤回此判断"),
    ]
    return "\n".join(lines)


def plan_url(message: s.PlanCard | s.RulePlanFallback) -> str:
    return f"{settings.FRONTEND_HOST.rstrip('/')}{message.link}"


def plan_links(message: s.Message) -> list[tuple[str, str]]:
    plan = message.plan if isinstance(message, s.CapacityCard) else message
    if not isinstance(plan, s.PlanCard):
        return []
    links = [(tr("在方案页修改"), plan_url(plan))]
    if plan.rule_fallback is not None:
        links.append((tr("查看备选方案"), plan_url(plan.rule_fallback)))
    return links


def render(message: s.Message) -> tuple[str, list[dict[str, JsonValue]]]:
    if isinstance(message, s.TextMessage):
        return message.text, []
    if isinstance(message, s.FeasibilityCard):
        return feasibility_text(message), []
    if isinstance(message, s.ProjectDraftCard):
        lines = [tr("项目草稿：{title}", title=message.project.title)]
        lines.extend(
            tr("{label}：{value}", label=field.label, value=field.value)
            for field in message.fields
        )
        # Leave room for the link within Feishu's card text budget.
        if len("\n\n".join(lines)) > 2500:
            lines[2:] = [
                tr(
                    "{label}：{value}",
                    label=field.label,
                    value=field.value.splitlines()[0][:90],
                )
                for field in message.fields[1:]
            ]
        if message.web_link:
            lines.append(
                tr(
                    "在网页核对并确认：{url}",
                    url=f"{settings.FRONTEND_HOST.rstrip('/')}{message.web_link}",
                )
            )
        return "\n\n".join(lines), []
    if isinstance(message, s.CapacityCard):
        questions = "\n".join(message.questions)
        fields = "\n".join(
            tr(
                "{label}：{value}{unclear}",
                label=field.label,
                value=field.value,
                unclear=tr("（请确认）") if field.unclear else "",
            )
            for field in message.fields
        )
        text = "\n".join(
            filter(
                None,
                [
                    message.title,
                    questions,
                    fields,
                    message.content,
                    message.result or tr("请核对后点击确认，或取消。"),
                ],
            )
        )
        if message.plan is not None:
            text += "\n" + render(message.plan)[0]
        if message.detail_link is not None:
            text += "\n" + tr(
                "{label}：{url}",
                label=message.detail_link.label,
                url=f"{settings.FRONTEND_HOST.rstrip('/')}{message.detail_link.href}",
            )
        return text, [a.model_dump(mode="json") for a in message.actions]
    if isinstance(message, s.PlanCard):
        fields = "\n".join(
            tr("{label}：{value}", label=field.label, value=field.value)
            for field in message.fields
        )
        text = "\n".join(
            filter(
                None,
                [
                    message.title,
                    fields,
                    tr("本次调整：{changes}", changes=message.changes)
                    if message.changes
                    else "",
                    tr("在方案页修改：{url}", url=plan_url(message)),
                ],
            )
        )
        if message.rule_fallback is not None:
            fallback = message.rule_fallback
            text += f"\n{tr('备选方案')}\n" + "\n".join(
                tr("{label}：{value}", label=field.label, value=field.value)
                for field in fallback.fields
            )
            text += f"\n{tr('与推荐方案对比')}\n" + "\n".join(
                tr("{label}：{value}", label=field.label, value=field.value)
                for field in fallback.differences
            )
            text += "\n" + tr("查看备选方案：{url}", url=plan_url(fallback))
        return text, []
    if isinstance(message, s.ProfileEditCard):
        text = (
            tr("直接修改画像：{name}", name=message.employee_name)
            + "\n"
            + "\n\n".join(
                f"{item.capability_name}\n"
                + tr(
                    "修改前：{claim}",
                    claim=claim_text(s.Claim.model_validate(item.before))
                    if item.before
                    else tr("暂无记录"),
                )
                + "\n"
                + tr(
                    "修改后：{claim}",
                    claim=claim_text(s.Claim.model_validate(item.after)),
                )
                for item in message.items
            )
            + "\n"
            + tr("确认后立即发布并通知员工。")
        )
        if len(text) > 12000:
            return tr("修改内容较长，请缩小改动后重新生成确认卡。"), []
        return text, [a.model_dump(mode="json") for a in message.actions]
    if isinstance(message, s.ReviewCard):
        decisions = {d.item_id: d for d in message.decisions}
        text = (
            tr("审批决定确认（第 {revision} 版）", revision=message.revision)
            + "\n"
            + "\n\n".join(
                tr(
                    "第 {index} 项：{name}",
                    index=index + 1,
                    name=item.after.capability.name,
                )
                + "\n"
                + tr("修改前：{claim}", claim=claim_text(item.before))
                + "\n"
                + tr("修改后：{claim}", claim=claim_text(item.after.after))
                + "\n"
                + tr(
                    "相关记录：{evidence}",
                    evidence=tr("、").join(e.title for e in item.evidence)
                    or tr("暂无"),
                )
                + "\n"
                + (f"{tr('仅来自 Jira，批准后为「暂定」')}\n" if item.jira_only else "")
                + tr(
                    "审批决定：{decision}",
                    decision=tr(LABELS[decisions[item.after.id].decision]),
                )
                + "\n"
                + tr(
                    "说明：{reason}",
                    reason=decisions[item.after.id].reason or tr("未填写"),
                )
                for index, item in enumerate(message.items)
            )
            + "\n"
            + tr(
                "详情在网页审批页查看：{url}",
                url=f"{settings.FRONTEND_HOST.rstrip('/')}/reviews/{message.id}",
            )
        )
        if len(text) > 12000:
            return tr("审批内容较长，请在网页审批页查看并决定。"), []
        return text, [a.model_dump(mode="json") for a in message.actions]
    if isinstance(message, s.QuestionCard):
        status_label = tr("待确认问题") if message.status == "open" else tr("已回答")
        return (
            tr(
                "{status}：{question}\n原因：{reason}",
                status=status_label,
                question=message.question,
                reason=message.reason,
            ),
            [
                {"action": a, "question_id": str(message.id)}
                for a in message.actions[:3]
            ],
        )
    if isinstance(message, s.PreviewCard):
        text = (
            tr("改动预览")
            + "\n"
            + "\n\n".join(
                f"{item.after.capability.name}\n"
                + tr(
                    "修改前：{statement}；等级：{level}",
                    statement=item.before.statement if item.before else tr("暂无记录"),
                    level=(item.before.level_name or tr("未定级"))
                    if item.before
                    else tr("未定级"),
                )
                + "\n"
                + tr("修改后：{item}", item=item_text(item.after))
                + (f"\n{item.submission_notice}" if item.submission_notice else "")
                for item in message.items
            )
        )
        if message.requires_manager:
            text += "\n"
            if message.partial_auto_publish:
                text += tr("需经理确认的改动：")
            text += (
                tr(
                    "提交后由 {reviewers}审批",
                    reviewers=tr("、").join(
                        tr("{name}（{role}）", name=r.name, role=tr(r.role))
                        for r in message.reviewers
                    ),
                )
                if message.reviewers
                else tr("暂未配置部门审批人，将由企业管理员处理")
            )
        if len(text) > 12000:
            return tr("预览内容较长，请在网页查看完整内容并确认提交。"), []
    else:
        status = LABELS.get(message.status, message.status)
        text = (
            tr("请求状态：{status}", status=tr(status))
            + "\n"
            + "\n\n".join(item_text(i) for i in message.items)
        )
        if message.status == "pending_review":
            text += "\n" + (
                tr(
                    "待经理审批：{reviewers}",
                    reviewers=tr("、").join(
                        tr("{name}（{role}）", name=r.name, role=tr(r.role))
                        for r in message.reviewers
                    ),
                )
                if message.reviewers
                else tr("暂未配置部门审批人，将由企业管理员处理")
            )
    return text, [a.model_dump(mode="json") for a in message.actions[:3]]
