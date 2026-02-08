local file, line, col = ...

local bufnr = vim.fn.bufnr(file)
if bufnr == -1 then
  return { error = "Buffer not found for " .. file .. " (sync_buffer should be called first)" }
end

local params = {
  textDocument = vim.lsp.util.make_text_document_params(bufnr),
  position = { line = line - 1, character = col - 1 }
}

local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/definition', params, 3000)
if not responses then
  return { error = "No definition response" }
end

local results = {}
for _, resp in pairs(responses) do
  if resp.result then
    local defs = type(resp.result[1]) == "table" and resp.result or { resp.result }
    for _, def in ipairs(defs) do
      local uri = def.uri or def.targetUri
      local range = def.range or def.targetSelectionRange
      if uri and range then
        table.insert(results, {
          file = vim.uri_to_fname(uri),
          line = range.start.line + 1,
          col = range.start.character + 1
        })
      end
    end
  end
end

return results
