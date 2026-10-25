-- Record, per buffer and per LSP client, when that client last reported
-- diagnostics. DiagnosticChanged can't tell an empty report from one client
-- apart from another client's, so we wrap each client's own handlers for push
-- (textDocument/publishDiagnostics) and pull (textDocument/diagnostic)
-- diagnostics. Idempotent: safe to run on every bridge call.
local state = _G.__nvim_lsp_bridge or {}
_G.__nvim_lsp_bridge = state
-- reports[bufnr][client_id] = { at = vim.uv.now(), error = string? }
state.reports = state.reports or {}
-- Wrapper functions we installed, so we never wrap our own wrapper.
state.wrappers = state.wrappers or setmetatable({}, { __mode = 'k' })

local function record(bufnr, client_id, err)
  if not bufnr or bufnr <= 0 then
    return
  end
  state.reports[bufnr] = state.reports[bufnr] or {}
  state.reports[bufnr][client_id] = { at = vim.uv.now(), error = err }
end

local function wrap(client, method, on_report)
  local current = client.handlers[method]
  if current and state.wrappers[current] then
    return
  end
  local wrapper = function(err, result, ctx, config)
    pcall(on_report, err, result, ctx)
    local handler = current or vim.lsp.handlers[method]
    return handler(err, result, ctx, config)
  end
  state.wrappers[wrapper] = true
  client.handlers[method] = wrapper
end

local function track(client)
  wrap(client, 'textDocument/publishDiagnostics', function(_, params, ctx)
    record(vim.fn.bufadd(vim.uri_to_fname(params.uri)), ctx.client_id)
  end)
  wrap(client, 'textDocument/diagnostic', function(err, _, ctx)
    -- Neovim re-sends cancelled pull requests itself; wait for that answer.
    if err and err.code == vim.lsp.protocol.ErrorCodes.ServerCancelled then
      return
    end
    record(ctx.bufnr, ctx.client_id, err and (err.message or tostring(err.code)) or nil)
  end)
end

for _, client in ipairs(vim.lsp.get_clients()) do
  track(client)
end

-- Clients that start later (e.g. the first time a bridge call opens a file
-- of a new filetype) get wrapped on attach, before they can publish.
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('nvim_lsp_bridge_track', { clear = true }),
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client then
      track(client)
    end
  end,
})

return true
