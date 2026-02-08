local file = select(1, ...)

-- Get or create buffer
local bufnr = vim.fn.bufnr(file, true)

-- Ensure buffer is loaded (reads from disk if not yet loaded)
if not vim.api.nvim_buf_is_loaded(bufnr) then
  vim.fn.bufload(bufnr)
end

-- Read current disk content and sync to buffer
local ok, disk_lines = pcall(vim.fn.readfile, file)
if not ok then
  return { error = "Could not read file: " .. file }
end

local buf_lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local changed = not vim.deep_equal(buf_lines, disk_lines)

if changed then
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, disk_lines)
  vim.bo[bufnr].modified = false
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

-- If content changed or LSP just attached, wait for diagnostics to settle
if changed then
  local got_update = false
  local group = vim.api.nvim_create_augroup('nvim_lsp_bridge_sync', { clear = true })
  vim.api.nvim_create_autocmd('DiagnosticChanged', {
    group = group,
    buffer = bufnr,
    once = true,
    callback = function()
      got_update = true
    end
  })
  -- Wait up to 10s for LSP to publish diagnostics
  vim.wait(10000, function() return got_update end, 50)
  pcall(vim.api.nvim_del_augroup_by_id, group)
end

return { bufnr = bufnr }
