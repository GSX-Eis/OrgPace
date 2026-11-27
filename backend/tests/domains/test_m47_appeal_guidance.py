import pytest
from sqlmodel import Session

from app.domains.admin_assistant import prompts as admin_prompts
from app.domains.bot import prompts as bot_prompts
from scripts.eval_admin_assistant import tasks
from tests.admin_assistant.test_registry import principal


@pytest.mark.parametrize("entry", ["admin", "web", "feishu"])
def test_appeal_guidance(db: Session, shared_demo: tuple, entry: str) -> None:
    p = principal(db, shared_demo, "admin" if entry == "admin" else "employee")
    prompt = (
        admin_prompts.system_prompt(p, "/admin/assistant")
        if entry == "admin"
        else bot_prompts.system_prompt(db, p, entry)
    )
    for text in (
        "已取消被拒申诉流程",
        "自己的画像页",
        "「已处理请求」",
        "「修改重提」",
        "「其他待处理请求」",
        "页面上没有申诉按钮是正常的",
        "对已批准或经理直接修改的判断有异议",
        "提交修改请求由经理审批",
        "不能代为申诉",
    ):
        assert text in prompt, f"{entry}: 缺少重提指引 {text}"
    assert "点击「申诉」" not in prompt
    assert "点击申诉" not in prompt


def test_admin_appeal_eval_task_parses() -> None:
    task = next(task for task in tasks() if task.id == "m47-admin-appeal-entry")
    assert task.actor == "admin"
    assert task.entry == "admin_assistant"
    assert task.steps[0]["text"] == "我想申诉，在哪儿操作？"
    assert task.expect == {"unchanged": True}
