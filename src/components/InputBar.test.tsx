/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import InputBar from './InputBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('InputBar mobile actions', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: (handle: number) => window.clearTimeout(handle),
    })
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    container?.remove()
    container = null
  })

  it('shows the mobile upload action as text without an icon', async () => {
    await act(async () => {
      root = createRoot(container!)
      root.render(<InputBar />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const uploadButtons = Array.from(container!.querySelectorAll('button'))
      .filter((button) => button.getAttribute('aria-label') === '上传参考图')

    expect(uploadButtons).toHaveLength(2)
    uploadButtons.forEach((uploadButton) => {
      expect(uploadButton.textContent).toContain('上传参考图')
      expect(uploadButton.querySelector('svg')).toBeNull()
    })
  })
})
