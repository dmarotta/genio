import fs from 'node:fs'
import { parse } from '@babel/parser'
import { expect, it } from 'vitest'

/** Guard presentation expressions, not routing props, keys or stored data. */
function identityLeaks(source: string, functionName?: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const aliases = new Map<string, any>()
  const walk = (node: any, visit: (n: any, parent?: any) => void, parent?: any): void => {
    if (!node || typeof node !== 'object') return
    visit(node, parent)
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(child => walk(child, visit, node))
      else if (value && typeof value === 'object') walk(value, visit, node)
    }
  }
  walk(ast, n => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) aliases.set(n.id.name, n.init)
  })
  const fromProject = (node: any, seen = new Set<string>()): boolean => {
    if (!node || typeof node !== 'object') return false
    if (node.type === 'Identifier') {
      if (/^(workspace|base|project|name|workspaceName|baseName|projectName)$/.test(node.name)) return true
      const value = aliases.get(node.name)
      if (!value || seen.has(node.name)) return false
      return fromProject(value, new Set([...seen, node.name]))
    }
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return /^(name|workspace|displayName)$/.test(node.property.name)
    // Calls produce timestamps, context labels and counts, not assistant names.
    if (['CallExpression', 'JSXElement', 'JSXFragment'].includes(node.type)) return false
    if (node.type === 'LogicalExpression') return fromProject(node.right, seen)
    if (node.type === 'ConditionalExpression') return fromProject(node.consequent, seen) || fromProject(node.alternate, seen)
    return Object.entries(node).some(([key, value]) => {
      if (['loc', 'start', 'end', 'extra'].includes(key)) return false
      return Array.isArray(value) ? value.some(child => fromProject(child, seen)) : fromProject(value, seen)
    })
  }
  const leaks: string[] = []
  const visit = (n: any, parent?: any): void => {
    if (n.type === 'JSXExpressionContainer') {
      const attribute = parent?.type === 'JSXAttribute' && /^(title|placeholder)$/.test(parent.name.name)
      const text = parent?.type === 'JSXElement'
      // Tool names identify tools, never speakers.
      const toolTrace = text && parent.openingElement.attributes.some((a: any) => a.name?.name === 'className' && a.value?.value?.includes('trace-name'))
      if ((attribute || text && !toolTrace) && fromProject(n.expression)) leaks.push(source.slice(n.expression.start, n.expression.end))
    }
    if (n.type === 'ObjectProperty' && n.key.name === 'displayName' && fromProject(n.value)) leaks.push(source.slice(n.start, n.end))
    if (n.type === 'TemplateLiteral' && /Message |is on it|is working|picked that message/.test(n.quasis.map((q: any) => q.value.raw).join(''))
      && n.expressions.some((e: any) => fromProject(e))) leaks.push(source.slice(n.start, n.end))
  }
  let root: any = ast
  if (functionName) {
    walk(ast, n => { if (n.type === 'FunctionDeclaration' && n.id?.name === functionName) root = n })
    expect(root.type, functionName).toBe('FunctionDeclaration')
  }
  walk(root, visit)
  return leaks
}

it('rejects project/base names in chat identity text, placeholders, tooltips and service display names', () => {
  for (const [file, scope] of [
    ['src/renderer/src/views/Comms.tsx'],
    ['src/renderer/src/components/GenioPanel.tsx'],
    ['src/renderer/src/components/Overlays.tsx', 'PermissionPrompt'],
    ['src/main/workspace.ts']
  ]) expect(identityLeaks(fs.readFileSync(file, 'utf8'), scope), file).toEqual([])
})

it('catches the original regressions and aliases without rejecting routing or project window titles', () => {
  expect(identityLeaks(`
    const who = ally ? ally.name : 'Genio';
    const info = { name: home.name, displayName: ally ? ally.name : 'Genio' };
    const view = <div title={who + ' model'}>
      <span>{workspace === 'main' ? 'Genio' : workspace} is on it</span>
      <span>{m.workspace} · {clock(m.ts)}</span>
      <textarea placeholder={'Message ' + base} />
    </div>;
  `)).toHaveLength(5)
  expect(identityLeaks(`
    child.document.title = 'Genio chat · ' + project;
    const view = <ChatPanel workspace={project} key={workspace}><span>{ASSISTANT_NAME} · {clock(m.ts)}</span></ChatPanel>;
  `)).toEqual([])
})
