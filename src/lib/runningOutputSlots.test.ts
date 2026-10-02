import { describe, expect, it } from 'vitest'
import { buildRunningOutputSlots, buildStreamPreviewItems, buildVisibleOutputSlots, earliestOutputImageId, findStreamPreviewSrc } from './runningOutputSlots'

describe('running output slots', () => {
  it('does not borrow another request preview for the first slot', () => {
    expect(buildStreamPreviewItems(2, { 1: 'later-preview' }, 'running')).toEqual([
      { key: '0', src: '' },
      { key: '1', src: 'later-preview' },
    ])
  })

  it('keeps images from the same request together without taking the next request slot', () => {
    expect(buildRunningOutputSlots({
      requestedCount: 2,
      outputImages: ['later', 'first-a', 'first-b'],
      outputImageRequestIndexes: [1, 0, 0],
      outputImageSubIndexes: [0, 0, 1],
    }).map((slot) => slot.imageId)).toEqual(['first-a', 'first-b', 'later'])
  })

  it('shows a failed request in its own slot while a later image stays in place', () => {
    const slots = buildRunningOutputSlots({
      requestedCount: 2,
      outputImages: ['second'],
      outputImageRequestIndexes: [1],
      outputImageSubIndexes: [0],
      outputErrors: [{ requestIndex: 0, error: 'slot failed' }],
    })

    expect(slots.map((slot) => [slot.imageId, slot.error])).toEqual([
      ['', 'slot failed'],
      ['second', ''],
    ])
  })

  it('uses the earliest completed image as the running cover', () => {
    expect(earliestOutputImageId({
      outputImages: ['later', 'earlier'],
      outputImageRequestIndexes: [1, 0],
      outputImageSubIndexes: [0, 0],
    })).toBe('earlier')
    expect(earliestOutputImageId({ outputImages: ['only'] })).toBe('only')
  })

  it('uses the request slot instead of the page index for stream previews', () => {
    const items = buildStreamPreviewItems(2, { 1: 'second-preview' }, 'running')
    expect(findStreamPreviewSrc(items, 0)).toBe('')
    expect(findStreamPreviewSrc(items, 1)).toBe('second-preview')
  })

  it('spreads an unsplit multi-image response across its own slots while running', () => {
    expect(buildVisibleOutputSlots({
      status: 'running',
      requestedCount: 4,
      outputImages: ['a', 'b'],
      outputImageRequestIndexes: [0, 1],
      outputImageSubIndexes: [0, 0],
    }).map((slot) => slot.imageId)).toEqual(['a', 'b', '', ''])
  })

  it('keeps images from one response together and the failed request after them once finished', () => {
    expect(buildVisibleOutputSlots({
      status: 'done',
      requestedCount: 2,
      outputImages: ['a', 'b'],
      outputImageRequestIndexes: [0, 0],
      outputImageSubIndexes: [0, 1],
      outputErrors: [{ requestIndex: 1, error: 'slot failed' }],
    }).map((slot) => [slot.imageId, slot.error])).toEqual([
      ['a', ''],
      ['b', ''],
      ['', 'slot failed'],
    ])
  })

  it('shows interrupted images in request order without leftover empty slots', () => {
    expect(buildVisibleOutputSlots({
      status: 'error',
      requestedCount: 3,
      outputImages: ['later', 'earlier'],
      outputImageRequestIndexes: [2, 0],
      outputImageSubIndexes: [0, 0],
    }).map((slot) => slot.imageId)).toEqual(['earlier', 'later'])
  })

  it('keeps the old one-image-per-request order when a finished task has no slot indexes', () => {
    expect(buildVisibleOutputSlots({
      status: 'done',
      requestedCount: 3,
      outputImages: ['a', 'c'],
      outputErrors: [{ requestIndex: 1, error: 'missing' }],
    }).map((slot) => [slot.imageId, slot.error])).toEqual([
      ['a', ''],
      ['', 'missing'],
      ['c', ''],
    ])
  })
})
