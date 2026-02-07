local filter_file = select(1, ...)
local diags = vim.diagnostic.get()
local results = {}
for _, d in ipairs(diags) do
  local fname = vim.api.nvim_buf_get_name(d.bufnr or 0)
  if filter_file == nil or fname:find(filter_file, 1, true) then
    table.insert(results, {
      file = fname,
      line = d.lnum + 1,
      col = d.col + 1,
      severity = d.severity,
      message = d.message,
      source = d.source or "unknown"
    })
  end
end
return results
