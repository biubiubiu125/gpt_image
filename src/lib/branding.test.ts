import { describe, expect, it } from 'vitest'
import { API_BRAND_NAME, APP_NAME, DEFAULT_API_URL, REPOSITORY_URL } from './branding'

describe('branding constants', () => {
  it('uses the gpt_image and RK API identity', () => {
    expect(APP_NAME).toBe('gpt_image')
    expect(API_BRAND_NAME).toBe('RK API')
    expect(DEFAULT_API_URL).toBe('https://api.veridiantech1.com')
    expect(REPOSITORY_URL).toBe('https://github.com/biubiubiu125/gpt_image')
  })
})
