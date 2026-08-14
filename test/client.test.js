'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

test('Client 模块可加载，并声明 slots/timer 后注册 dock', () => {
  let clientPlugin
  let registered
  const react = { createElement: (...args) => ({ args }) }
  global.window = {
    __ModuleLoader__: {
      load(definition) {
        assert.strictEqual(definition.id, 'deepseek-git-guide')
        clientPlugin = definition.factory((name) => {
          assert.strictEqual(name, 'react')
          return react
        })
      },
    },
  }
  try {
    delete require.cache[require.resolve('../lib/client')]
    require('../lib/client')
  } finally {
    delete global.window
  }

  assert.deepStrictEqual(clientPlugin.inject, ['slots', 'timer'])
  const slots = {
    inject(name, callback) {
      assert.strictEqual(name, 'conversation.input.dock')
      return callback()
    },
    register(definition, renderer) {
      registered = { definition, renderer }
      return () => {}
    },
  }
  const timer = { interval: () => () => {}, timeout: () => () => {} }
  clientPlugin.apply({ get: (key) => key === 'slots' ? slots : key === 'timer' ? timer : undefined, timer })
  assert.strictEqual(registered.definition.id, 'git-guide')
  assert.strictEqual(typeof registered.renderer, 'function')
})
