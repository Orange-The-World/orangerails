import { describe, expect, it } from 'vitest'

// DEV-0283 proof fixture. Throwaway, never merged. See the commit message.
//
// Before the fix on the parent branch, a pull request based on a feature
// branch ran no vitest job at all and still reported GREEN. This file fails on
// purpose so the check list shows the suite running AND able to go red on a
// stacked pull request, which is what "proven able to fail" means.
describe('DEV-0283: CI runs on a stacked pull request', () => {
  it('passes, proving the vitest job executed at all', () => {
    expect(1 + 1).toBe(2)
  })

  it('fails on purpose, proving the job can report red', () => {
    expect('the suite ran').toBe('this assertion is meant to fail')
  })
})
