import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Plain node stands in for the app's Electron here. Each layout is made in a temporary folder laid out as a checkout
// with the app packaged inside it, and its folders are named node_modules, as require.resolve's paths search them.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts', 'check-native-modules.cjs')
const binding = join('onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node')

let dir = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

// A repo's node_modules, and a packaged one below it: sharp in the one `sharp` names, and what each argument adds.
function layout({ sharp = 'packaged', ort = true, packagedBinding = false, installedBinding = false } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'check-native-modules-'))
  const installed = join(dir, 'node_modules')
  const packaged = join(dir, 'dist', 'app', '.next', 'standalone', 'node_modules')
  mkdirSync(packaged, { recursive: true })
  mkdirSync(installed, { recursive: true })
  if (sharp) {
    const modules = sharp === 'packaged' ? packaged : installed
    const { dependencies } = JSON.parse(readFileSync(join(root, 'node_modules', 'sharp', 'package.json'), 'utf8'))
    for (const name of ['sharp', '@img', ...Object.keys(dependencies).filter(name => !name.startsWith('@img/'))])
      cpSync(join(root, 'node_modules', name), join(modules, name), { recursive: true, dereference: true })
  }
  if (ort) mkdirSync(join(packaged, 'onnxruntime-node'))
  for (const [has, modules] of [[packagedBinding, packaged], [installedBinding, installed]]) {
    if (!has) continue
    mkdirSync(dirname(join(modules, binding)), { recursive: true })
    writeFileSync(join(modules, binding), '')
  }
  return { packaged, installed }
}

describe('check-native-modules', () => {
  it('exits 2 without both node_modules', () => {
    expect(run('x').status).toBe(2)
  })

  it('fails when sharp is not in the package', () => {
    const { packaged, installed } = layout({ sharp: null })
    expect(run(packaged, installed).status).toBe(1)
  })

  it('fails when sharp loads from the repo above the package, as require.resolve finds it there', () => {
    const { packaged, installed } = layout({ sharp: 'installed' })
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(1)
    expect(stdout).toContain('::error::sharp loads')
  })

  it('fails when onnxruntime-node is not in the package', () => {
    const { packaged, installed } = layout({ ort: false })
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(1)
    expect(stdout).toContain('::error::onnxruntime-node is not in the packaged app')
  })

  it('fails when the package lacks a binding that onnxruntime-node ships', () => {
    const { packaged, installed } = layout({ installedBinding: true })
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(1)
    expect(stdout).toContain(`::error::the packaged app has no ${binding}`)
  })

  it('warns and passes where onnxruntime-node ships no binding, as on an Intel Mac', () => {
    const { packaged, installed } = layout()
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(0)
    expect(stdout).toContain('::warning::onnxruntime-node ships no binding')
  })

  it('fails when a binding in the package does not load', () => {
    const { packaged, installed } = layout({ packagedBinding: true, installedBinding: true })
    expect(run(packaged, installed).status).not.toBe(0)
  }, 20_000)

  // The real onnxruntime-node, with only this target's binding copied, where the repo has one (not on an Intel Mac).
  const realOrt = existsSync(join(root, 'node_modules', binding))
  function withRealOrt(layoutDirs, commonIn) {
    const from = join(root, 'node_modules', 'onnxruntime-node')
    const to = join(layoutDirs.packaged, 'onnxruntime-node')
    for (const part of ['package.json', 'dist', dirname(binding.slice('onnxruntime-node/'.length))])
      cpSync(join(from, part), join(to, part), { recursive: true, dereference: true })
    cpSync(join(root, 'node_modules', 'onnxruntime-common'), join(layoutDirs[commonIn], 'onnxruntime-common'), { recursive: true, dereference: true })
    return layoutDirs
  }

  it.runIf(realOrt)('passes when everything loads from the package', () => {
    const { packaged, installed } = withRealOrt(layout(), 'packaged')
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(0)
    expect(stdout).toContain('onnxruntime-node: loads')
  }, 20_000)

  it.runIf(realOrt)('fails when a dependency of onnxruntime-node loads from the repo above the package', () => {
    const { packaged, installed } = withRealOrt(layout(), 'installed')
    const { status, stdout } = run(packaged, installed)
    expect(status).toBe(1)
    expect(stdout).toContain('::error::onnxruntime-node loads')
  }, 20_000)
})
