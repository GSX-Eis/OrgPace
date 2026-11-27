import { type APIRequestContext, expect } from "@playwright/test"

export async function seedLegacyAcceptedDemand(
  request: APIRequestContext,
  orgId: string,
  demandId: string,
  adminToken: string,
) {
  const response = await request.post(
    `/api/v1/private/orgs/${orgId}/legacy-accepted-demands/${demandId}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  )
  expect(response.status(), await response.text()).toBe(204)
}
