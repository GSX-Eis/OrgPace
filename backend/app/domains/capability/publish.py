"""Publish a dictionary and its optional drafting job in one transaction."""

from collections.abc import Callable
from uuid import UUID

from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.capability.proposals import accept_proposals
from app.domains.capability.schemas import ActiveSchemaPublic, SaveDictionary
from app.domains.capability.service import DictionaryChangeNotifier, save_version

type RedraftTrigger = Callable[[Session, UUID], object]


def save_dictionary(
    session: Session,
    principal: Principal,
    body: SaveDictionary,
    *,
    commit: bool = True,
    on_redraft: RedraftTrigger | None = None,
    on_request_remapped: DictionaryChangeNotifier | None = None,
) -> ActiveSchemaPublic:
    schema = save_version(
        session,
        principal,
        body.definitions,
        expected_version=body.expected_version,
        on_request_remapped=on_request_remapped,
    )
    accept_proposals(session, principal, [d.name for d in body.definitions])
    result = ActiveSchemaPublic.model_validate(schema)
    if body.redraft and on_redraft is not None:
        on_redraft(session, principal.org_id)
    if commit:
        session.commit()
    return result
