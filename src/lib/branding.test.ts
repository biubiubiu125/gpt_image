import { describe, expect, it } from 'vitest'
import { getApiProfileDisplayName, getApiProviderLabel } from './apiProfiles'
import { API_BRAND_NAME, APP_NAME, DEFAULT_API_URL, REPOSITORY_URL } from './branding'

describe('branding constants', () => {
  it('uses the gpt_image and RK API identity', () => {
    expect(APP_NAME).toBe('gpt_image')
    expect(API_BRAND_NAME).toBe('RK API')
    expect(DEFAULT_API_URL).toBe('https://api.veridiantech1.com')
    expect(REPOSITORY_URL).toBe('https://github.com/biubiubiu125/gpt_image')
  })

  it('uses RK API for the built-in provider label', () => {
    expect(getApiProviderLabel({}, 'openai')).toBe('RK API')
  })

  it('maps the legacy OpenAI default profile label to RK API', () => {
    expect(getApiProfileDisplayName('默认', 'openai')).toBe('RK API')
    expect(getApiProfileDisplayName('默认')).toBe('RK API')
    expect(getApiProfileDisplayName('默认', 'fal')).toBe('默认')
  })

})
