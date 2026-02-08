local file = select(1, ...)

-- Get or create buffer
local bufnr = vim.fn.bufnr(file, true)

-- Ensure buffer is loaded (reads from disk if not yet loaded)
if not vim.api.nvim_buf_is_loaded(bufnr) then
  vim.fn.bufload(bufnr)
end

-- Check if buffer content differs from disk
local ok, disk_lines = pcall(vim.fn.readfile, file)
if not ok then
  return { error = "Could not read file: " .. file }
end

local buf_lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local changed = not vim.deep_equal(buf_lines, disk_lines)

if changed then
  -- Use :edit! to reload from disk — this triggers the LSP on_reload callback
  -- which sends didClose + didOpen to ALL attached clients (full resync)
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd('edit!')
  end)
  -- Refresh bufnr in case it changed during reload
  bufnr = vim.fn.bufnr(file)
end

-- Ensure LSP is attached
local clients = vim.lsp.get_clients({ bufnr = bufnr })
if #clients == 0 then
  -- Trigger filetype detection to get LSP attached via autocmds
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd('filetype detect')
  end)
  -- Wait for LSP client to attach (up to 5s)
  vim.wait(5000, function()
    return #vim.lsp.get_clients({ bufnr = bufnr }) > 0
  end, 50)

  clients = vim.lsp.get_clients({ bufnr = bufnr })
  if #clients == 0 then
    return { error = "No LSP client attached to " .. file }
  end
  -- LSP just attached and needs to process the initial didOpen
  changed = true
end

-- If content changed or LSP just attached, trigger save notification and wait for diagnostics
if changed then
  -- Trigger BufWritePost so Neovim's built-in LSP handler sends didSave to all clients
  -- This is needed for on-save linters like ESLint
  vim.api.nvim_exec_autocmds('BufWritePost', { buffer = bufnr })

  -- Wait for diagnostics to settle: no DiagnosticChanged for 500ms, or 10s total
  local got_first = false
  local last_update = 0
  local group = vim.api.nvim_create_augroup('nvim_lsp_bridge_sync', { clear = true })
  vim.api.nvim_create_autocmd('DiagnosticChanged', {
    group = group,
    buffer = bufnr,
    callback = function()
      got_first = true
      last_update = vim.uv.now()
    end
  })
  vim.wait(10000, function()
    return got_first and (vim.uv.now() - last_update) >= 500
  end, 50)
  pcall(vim.api.nvim_del_augroup_by_id, group)
end

return { bufnr = bufnr }
