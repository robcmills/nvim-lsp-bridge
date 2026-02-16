
- [ ] Fix stale diagnostics
   The following is stdout from a claude code session:

```
❯ Check for type errors on edited files using the nvim-lsp diagnostics tool 

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaDetailDialog.tsx")
  ⎿  [
       {
         "severity": 1,
     … +10 lines (ctrl+o to expand)

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaSidebar/MediaSidebar.tsx")
  ⎿  []

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaSidebar/InfoView/InfoView.tsx")
  ⎿  []

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaSidebar/LocationView/LocationView.tsx")
  ⎿  []

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaSidebar/DetailView.tsx")
  ⎿  []

⏺ The LSP may have a stale cache for MediaSidebar's types. Let me verify the interface was actually updated.

⏺ Read 1 file (ctrl+o to expand)

⏺ The interface does include isMobile. The LSP diagnostic is stale — likely it hasn't re-evaluated MediaSidebar.tsx yet. Let
  me re-check after a moment.

⏺ nvim-lsp-bridge - get_diagnostics (MCP)(file: "/Users/robcmills/src/openspace/web/icedemon/src/js/site/media/MediaDetailDia
                                         log/MediaDetailDialog.tsx")
  ⎿  []

⏺ All clear — zero diagnostics across all edited files. Here's a summary of the changes:
```

I think this may be the following scenario:

1. agent edits file A
2. agent gets diagnostics for file B, which has a type error based on file A


- [ ] Reimplement in compiled language for an executable binary so users don't have to install bun
