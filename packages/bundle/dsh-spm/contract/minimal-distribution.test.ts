import { describe, expect, it } from 'vitest'
import { forbiddenDistributionReference } from '../../../../scripts/minimal-distribution.ts'

describe('minimum package reference isolation', () => {
  it('allows createLink object properties while still rejecting dependency protocols', () => {
    expect(forbiddenDistributionReference('createLink: (role, port) => new Link(port)', 'D:/source')).toBeUndefined()
    expect(forbiddenDistributionReference('{"dependencies":{"x":"link:../../x"}}', 'D:/source')).toBe('link:')
    expect(forbiddenDistributionReference('import x from "workspace:example"', 'D:/source')).toBe('workspace:')
    expect(forbiddenDistributionReference('import x from "D:/SOURCE/lib/x.js"', 'D:/source')).toBe('d:/source')
  })
})
