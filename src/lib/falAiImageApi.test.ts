import { fal } from '@fal-ai/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: vi.fn(),
    subscribe: vi.fn(),
    queue: {
      subscribeToStatus: vi.fn(),
      result: vi.fn(),
    },
  },
}))

const falMock = fal as unknown as {
  config: Mock
  subscribe: Mock
}

describe('callFalAiImageApi', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the default fal endpoint without proxyUrl', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
    })
  })

  it('passes custom fal API URL to the SDK proxyUrl option', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    }))

    expect(falMock.config).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
    })
  })

  it('publishes each fal image on its own slot instead of stacking them on the first request', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'YQ==' }, { b64_json: 'Yg==' }] },
    })
    const completed: Array<{ requestIndex: number; imageIndex: number }> = []

    const result = await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 4 },
      inputImageDataUrls: [],
      onCompletedImage: (image) => {
        completed.push({ requestIndex: image.requestIndex, imageIndex: image.imageIndex })
      },
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(completed).toEqual([
      { requestIndex: 0, imageIndex: 0 },
      { requestIndex: 1, imageIndex: 0 },
    ])
    expect(result.imageSlots).toEqual([
      { requestIndex: 0, imageIndex: 0 },
      { requestIndex: 1, imageIndex: 0 },
    ])
  })
})
