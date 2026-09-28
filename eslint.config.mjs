import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // `.dev` holds the generated fixture — a whole synthetic git repo with
  // worktrees. It is test data, not source, and linting it means the fixture
  // can fail the gate for code the app never runs.
  { ignores: ['**/node_modules', '**/dist', '**/out', '.dev', 'release'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // An error, not a warning. The gate only fails on errors, so this rule
      // was reporting into a wall of output nobody reads — and it had been
      // correctly flagging a shipped bug (a useCallback that did not depend on
      // the branch name it sent, so it sent the name from before you typed it)
      // for a day. A stale closure is not a style preference.
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  eslintConfigPrettier
)
