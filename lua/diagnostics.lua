local filter_files = select(1, ...)
if type(filter_files) == "string" then
  filter_files = { filter_files }
end

local function matches_filter(fname)
  if filter_files == nil then
    return true
  end
  for _, filter_file in ipairs(filter_files) do
    if fname:find(filter_file, 1, true) then
      return true
    end
  end
  return false
end

local diags = vim.diagnostic.get()
local results = {}
for _, d in ipairs(diags) do
  local fname = vim.api.nvim_buf_get_name(d.bufnr or 0)
  if matches_filter(fname) then
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
