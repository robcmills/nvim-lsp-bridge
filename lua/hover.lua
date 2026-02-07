local file, line, col = ...

-- Find or open the buffer
local bufnr = vim.fn.bufnr(file)
if bufnr == -1 then
  vim.cmd('badd ' .. file)
  bufnr = vim.fn.bufnr(file)
end

-- Get LSP clients for this buffer
local clients = vim.lsp.get_clients({ bufnr = bufnr })
if #clients == 0 then
  return { error = "No LSP client attached to " .. file }
end

-- Synchronous hover request
local params = {
  textDocument = vim.lsp.util.make_text_document_params(bufnr),
  position = { line = line - 1, character = col - 1 }
}

local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/hover', params, 3000)
if not responses then
  return { error = "No hover response" }
end

for _, resp in pairs(responses) do
  if resp.result and resp.result.contents then
    local contents = resp.result.contents
    if type(contents) == "table" then
      return { result = contents.value or vim.inspect(contents) }
    end
    return { result = tostring(contents) }
  end
end

return { error = "No hover info found" }
