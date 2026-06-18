#!/usr/bin/env bun
/**
 * local-mcp — CCoW コンテナ内で動く stdio MCP (bun 実行)。
 *
 * 目的: CCoW で書いた lib / SDK を **動的に読み込んで実行・検証**する。
 * deploy も publish もブラウザも挟まず、ワークスペースのソースをその場で叩ける。
 *
 * - transport: stdio (newline-delimited JSON-RPC 2.0)。`~/.claude.json` の
 *   mcpServers に `command: bun, args: [run, <この file>]` で登録する
 *   (登録は mcp-user-setup 系 skill が担当 / 反映は次 session)。
 * - 依存ゼロ。bun の組み込みだけで動く。
 *
 * tool: run({ code, cwd?, timeoutMs?, env? })
 *   - code は **bun の本物のモジュール**として実行される
 *     (static import / top-level await OK)。tsx 不要、bun が .ts を native 実行。
 *   - cwd 配下に一時 .ts を書き出して `bun <file>` を spawn するので、
 *     相対 import も対象 lib の node_modules も cwd 基準で解決する。
 *   - ログ: `console.log` の出力をそのまま返す。
 *   - 戻り値: `globalThis.__result = X` を立てると構造化値として返る。
 *   - 例外: module が throw すると非ゼロ終了 + stderr に stack。捕捉して返す。
 */

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'local-mcp', version: '0.1.0' }

const RESULT_SENTINEL = '__LIBRUN_RESULT__'

interface RunArgs {
  code: string
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

const TOOLS = [
  {
    name: 'run',
    description:
      'CCoW ワークスペースの lib/SDK を動的に読み込んで TS/JS snippet を実行し、結果を返す。'
      + ' snippet は bun の本物のモジュール (static import / top-level await 可)。'
      + ' ログは console.log、構造化戻り値は `globalThis.__result = X` で返す。'
      + ' import は cwd 基準で解決される (対象 lib の dir を cwd に指定する)。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '実行する TS/JS モジュールソース' },
        cwd: {
          type: 'string',
          description: 'import 解決と実行の作業ディレクトリ (例: /home/user/egov-shinsei-sdk)。省略時はプロセス cwd',
        },
        timeoutMs: { type: 'number', description: '実行タイムアウト (ms)。既定 30000' },
        env: {
          type: 'object',
          description: '追加の環境変数 (access_token 等を渡す用)',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['code'],
    },
  },
]

async function runSnippet(args: RunArgs): Promise<unknown> {
  const cwd = args.cwd ?? process.cwd()
  const timeoutMs = args.timeoutMs ?? 30000

  // snippet をそのまま module として書き出す (import を壊さないため wrap しない)。
  // 末尾に __result 回収トレーラだけ付ける。
  const trailer = `
;{
  const __r = (globalThis as any).__result;
  if (typeof __r !== 'undefined') {
    process.stdout.write('\\n${RESULT_SENTINEL}' + JSON.stringify(__r ?? null) + '\\n');
  }
}
`
  const tmpName = `.librun-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
  const tmpPath = `${cwd.replace(/\/$/, '')}/${tmpName}`
  await Bun.write(tmpPath, args.code + '\n' + trailer)

  const started = Date.now()
  let timedOut = false
  try {
    const proc = Bun.spawn(['bun', 'run', tmpName], {
      cwd,
      env: { ...process.env, ...(args.env ?? {}) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)

    const [stdoutRaw, stderrRaw] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    clearTimeout(timer)

    // sentinel 行を logs と分離
    let result: unknown
    let resultFound = false
    const logLines: string[] = []
    for (const line of stdoutRaw.split('\n')) {
      if (line.startsWith(RESULT_SENTINEL)) {
        try {
          result = JSON.parse(line.slice(RESULT_SENTINEL.length))
          resultFound = true
        }
        catch {
          result = line.slice(RESULT_SENTINEL.length)
          resultFound = true
        }
      }
      else {
        logLines.push(line)
      }
    }
    const stdout = logLines.join('\n').replace(/\n+$/, '')

    return {
      ok: exitCode === 0 && !timedOut,
      timedOut,
      exitCode,
      durationMs: Date.now() - started,
      ...(resultFound ? { result } : {}),
      stdout,
      stderr: stderrRaw.replace(/\n+$/, ''),
    }
  }
  finally {
    try { await Bun.file(tmpPath).unlink?.() } catch { /* ignore */ }
    // bun の Bun.file().unlink がない版向けフォールバック
    try { await import('node:fs/promises').then(fs => fs.rm(tmpPath, { force: true })) } catch { /* ignore */ }
  }
}

// ---- JSON-RPC stdio loop ----

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(req: any): Promise<void> {
  const { id, method, params } = req

  // 通知 (id 無し) は応答しない
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name !== 'run') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } })
      return
    }
    try {
      const out = await runSnippet(args as RunArgs)
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          isError: !(out as any).ok,
        },
      })
    }
    catch (e: any) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }],
          isError: true,
        },
      })
    }
    return
  }

  // 未知メソッド (id ありのみ応答)
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

// stdin を行単位で読む (newline-delimited JSON-RPC)
let buf = ''
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk)
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const req = JSON.parse(line)
      void handle(req)
    }
    catch {
      // パース不能行は無視 (fail-open)
    }
  }
}
