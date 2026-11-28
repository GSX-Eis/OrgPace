import pytest
from sqlalchemy import Column, Table, Uuid
from sqlmodel import Session, SQLModel, select

import app.models  # noqa: F401
from app.domains.audit.models import AuditEvent
from app.domains.capacity.models import CapacitySetting
from app.domains.evidence.models import Evidence
from app.domains.org.models import Organization, OrgMembership
from app.domains.profile.models import ProfileClaim, ProfileVersion
from app.domains.profile.schemas import SnapshotClaim
from tests.fixtures import _demo_snapshot
from tests.utils.org import ORG_MODELS, delete_test_organization, derive_org_models


def test_demo_clones_keep_frozen_references_in_their_own_tenant(
    db: Session, demo: tuple, shared_demo: tuple
) -> None:
    person = demo[1]["E02"]
    shared_person = shared_demo[1]["E02"]
    assert person.id != shared_person.id
    assert person.org_id != shared_person.org_id
    claim_ids = set(
        db.exec(select(ProfileClaim.id).where(ProfileClaim.org_id == person.org_id))
    )
    evidence_ids = set(
        db.exec(select(Evidence.id).where(Evidence.org_id == person.org_id))
    )
    version = db.exec(
        select(ProfileVersion).where(
            ProfileVersion.org_id == person.org_id,
            ProfileVersion.subject_employee_id == person.id,
            ProfileVersion.revision == 2,
        )
    ).one()
    snapshot = version.snapshot["claims"]
    assert isinstance(snapshot, list) and snapshot
    claims = [SnapshotClaim.model_validate(claim) for claim in snapshot]
    assert {claim.id for claim in claims} <= claim_ids
    refs = {ref.evidence_id for claim in claims for ref in claim.evidence}
    assert refs and refs <= evidence_ids

    receipt = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == person.org_id, AuditEvent.action == "seed.loaded"
        )
    ).one()
    assert receipt.target_id == str(person.org_id)


def test_batch_cleanup_guards_the_canonical_demo(db: Session, demo: tuple) -> None:
    clone_id = demo[1]["E02"].org_id
    canonical_id = db.exec(
        select(Organization.id).where(Organization.slug == "demo")
    ).one()
    with pytest.raises(ValueError, match="Only a test-owned organization"):
        delete_test_organization(db, clone_id, canonical_id)
    assert db.get(Organization, clone_id) is not None
    assert db.get(Organization, canonical_id) is not None


@pytest.mark.unit
def test_org_models_derived_from_metadata_cover_all_tenant_tables_in_fk_order() -> None:
    expected_tables = {
        table.name
        for table in SQLModel.metadata.sorted_tables
        if "org_id" in table.c and table.name != "organization"
    }
    derived_names = [str(model.__tablename__) for model in ORG_MODELS]
    assert len(derived_names) == len(set(derived_names))
    assert set(derived_names) == expected_tables

    capacity_tables = {
        table.name
        for table in SQLModel.metadata.sorted_tables
        if table.name.startswith("capacity_")
    }
    planning_tables = {
        table.name
        for table in SQLModel.metadata.sorted_tables
        if table.name.startswith("planning_")
    }
    assert len(capacity_tables) >= 20
    assert len(planning_tables) >= 3
    assert capacity_tables <= set(derived_names)
    assert planning_tables <= set(derived_names)

    pos = {name: idx for idx, name in enumerate(derived_names)}
    for name in derived_names:
        table = SQLModel.metadata.tables[name]
        for fk in table.foreign_keys:
            target = fk.column.table.name
            if target in pos and target != name:
                assert pos[name] < pos[target], f"{name} must precede {target}"

    # Non-ORM system tables (e.g. procrastinate_jobs / alembic_version) are excluded.
    fake_table = Table(
        "procrastinate_jobs",
        SQLModel.metadata,
        Column("org_id", Uuid),
        extend_existing=True,
    )
    try:
        assert "procrastinate_jobs" not in {
            str(m.__tablename__) for m in derive_org_models()
        }
    finally:
        SQLModel.metadata.remove(fake_table)


def test_demo_snapshot_detects_capacity_table_mutations(
    db: Session, demo: tuple
) -> None:
    person = demo[1]["E02"]
    org_id = person.org_id
    user_id = db.exec(
        select(OrgMembership.user_id).where(OrgMembership.org_id == org_id)
    ).first()
    assert user_id is not None

    before = _demo_snapshot(db, [org_id], [user_id])
    db.add(
        CapacitySetting(
            org_id=org_id,
            enabled=True,
            updated_by_user_id=user_id,
        )
    )
    db.commit()
    after = _demo_snapshot(db, [org_id], [user_id])
    changed = [name for name in before if before[name] != after[name]]
    assert changed == ["capacity_setting"]
