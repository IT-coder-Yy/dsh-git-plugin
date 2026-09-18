export interface ConflictBlock {
  start: number
  end: number
  ours: string
  base: string | null
  theirs: string
}

/** Result coordinates include marker lines, and update with the editor text. */
export function conflictLineRanges(text: string, blocks: ConflictBlock[]) {
  return blocks.map(block => ({
    start: text.slice(0, block.start).split('\n').length,
    end: text.slice(0, block.end).replace(/\n$/, '').split('\n').length,
  }))
}

/** Keep byte-for-byte text boundaries, including CRLF and a missing final newline. */
export function parseConflictBlocks(text: string, markerSize = 7): ConflictBlock[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const blocks: ConflictBlock[] = []
  let offset = 0
  let current: { start: number; ours: string; base: string | null; theirs: string; section: 'ours' | 'base' | 'theirs' } | null = null
  const marker = (line: string, character: string) => new RegExp('^' + (character === '|' ? '\\|' : character) + '{' + markerSize + '}(?:[ \\t\\r\\n]|$)').test(line)
  for (const line of lines) {
    if (marker(line, '<')) current = { start: offset, ours: '', base: null, theirs: '', section: 'ours' }
    else if (current && marker(line, '|') && current.section === 'ours') { current.base = ''; current.section = 'base' }
    else if (current && marker(line, '=') && current.section !== 'theirs') current.section = 'theirs'
    else if (current && marker(line, '>') && current.section === 'theirs') {
      blocks.push({ start: current.start, end: offset + line.length, ours: current.ours, base: current.base, theirs: current.theirs })
      current = null
    } else if (current) {
      if (current.section === 'base') current.base = (current.base ?? '') + line
      else current[current.section] += line
    }
    offset += line.length
  }
  return blocks
}

export function chooseConflictBlock(text: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both'): string {
  const replacement = choice === 'ours' ? block.ours : choice === 'theirs' ? block.theirs : block.ours + block.theirs
  return text.slice(0, block.start) + replacement + text.slice(block.end)
}
