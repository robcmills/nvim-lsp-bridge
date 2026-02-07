local file, line, col = ...

local bufnr = vim.fn.bufnr(file)
if bufnr == -1 then
  vim.cmd('badd ' .. file)
  bufnr = vim.fn.bufnr(file)
end

local params = {
  textDocument = vim.lsp.util.make_text_document_params(bufnr),
  position = { line = line - 1, character = col - 1 }
}

local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/completion', params, 3000)
if not responses then
  return { error = "No completion response" }
end

local results = {}
for _, resp in pairs(responses) do
  if resp.result then
    local items = resp.result.items or resp.result
    for i, item in ipairs(items) do
      if i > 20 then break end  -- limit results
      table.insert(results, {
        label = item.label,
        kind = item.kind,
        detail = item.detail
      })
    end
  end
end

return results
