-- For each requested buffer, list its attached LSP clients and when each last
-- reported diagnostics (see track_diagnostics.lua). The caller polls this to
-- decide when diagnostics are fresh, so Neovim's event loop is never blocked.
local bufnrs, since_list = select(1, ...), select(2, ...)
local state = _G.__nvim_lsp_bridge or { reports = {} }
state.pulled = state.pulled or {}

local method = 'textDocument/diagnostic'

-- Neovim only pulls diagnostics (e.g. eslint) on didOpen/didChange for buffers
-- shown in a window, and bridge buffers are hidden. Ask once per sync for each
-- pull client that hasn't reported yet. Right after :edit! a client can
-- briefly not match the method filter, so later polls retry until it does.
local function request_pull(bufnr, client, since)
  if not vim.lsp.diagnostic._refresh then
    return
  end
  state.pulled[bufnr] = state.pulled[bufnr] or {}
  if (state.pulled[bufnr][client.id] or -1) >= since then
    return
  end
  if #vim.lsp.get_clients({ bufnr = bufnr, id = client.id, method = method }) == 0 then
    return
  end
  state.pulled[bufnr][client.id] = vim.uv.now()
  pcall(vim.lsp.diagnostic._refresh, bufnr, client.id)
end

local results = {}
for i, bufnr in ipairs(bufnrs) do
  local since = since_list and since_list[i] or 0
  local clients = {}
  if vim.api.nvim_buf_is_valid(bufnr) then
    local reports = state.reports[bufnr] or {}
    for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
      local report = reports[client.id]
      -- The static capability doesn't flicker during re-attach like
      -- supports_method can.
      local pull = client.server_capabilities.diagnosticProvider ~= nil
        or client:supports_method(method, bufnr)
      if pull and not (report and report.at >= since) then
        request_pull(bufnr, client, since)
      end
      table.insert(clients, {
        id = client.id,
        name = client.name,
        root_dir = client.root_dir or vim.NIL,
        pull = pull,
        reported_at = report and report.at or vim.NIL,
        error = report and report.error or vim.NIL,
      })
    end
  end
  table.insert(results, { bufnr = bufnr, clients = clients })
end

return { now = vim.uv.now(), pid = vim.fn.getpid(), buffers = results }
