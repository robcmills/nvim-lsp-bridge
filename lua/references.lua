local file, line, col = ...

local bufnr = vim.fn.bufnr(file)
if bufnr == -1 then
  return { error = "Buffer not found for " .. file .. " (sync_buffer should be called first)" }
end

local params = {
  textDocument = vim.lsp.util.make_text_document_params(bufnr),
  position = { line = line - 1, character = col - 1 },
  context = { includeDeclaration = true }
}

local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/references', params, 5000)
if not responses then
  return { error = "No references response" }
end

local results = {}
for _, resp in pairs(responses) do
  if resp.result then
    for _, ref in ipairs(resp.result) do
      table.insert(results, {
        file = vim.uri_to_fname(ref.uri),
        line = ref.range.start.line + 1,
        col = ref.range.start.character + 1
      })
    end
  end
end

return results
