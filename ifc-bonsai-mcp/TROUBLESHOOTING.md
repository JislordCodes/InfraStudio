# Troubleshooting

This guide addresses common issues and limitations when using the Bonsai MCP server.

## Common Issues

### Embedding Server Port Configuration

The embedding server is configured to use port 8080 by default. The port number is manually set in `src/blender_mcp/mcp_functions/rag_tools.py` around line 190.

- If port 8080 is already in use, stop the existing process before launching the RAG embedding server
- To change the port, modify the configuration in the source file and update the `BLENDER_MCP_REMOTE_EMBEDDINGS_URL` environment variable accordingly

### Working with Empty Blender Files

The MCP server works on loaded IFC files in Blender. When a new Blender file is created but not saved, no IFC file exists for the server to access.

**Solution**: 
1. Always save the Blender file as an IFC file before starting the MCP server.
2. Use `Ctrl+S` (or `Cmd+S` on macOS) to save an empty IFC file if working with a new project.
3. Once the file is saved, the server can load and modify the IFC model directly.

### Execute Code Tool Limitations

The general `execute_code` tool behaves unpredictably with IFC operations. The general execute code tool lacks proper context handling, cannot save changes back to the model consistently and may produce unsafe results for IFC operations. Consider disabling the general `execute_code` tool if there are issues.

## Known Limitations

### Tool Quality and Geometry Creation

Some geometry creation tools may not work reliably, particularly for opening creation tools, door and window placement, and wall attachment mechanisms. Community contributions to improve creation tools are highly encouraged.

### Geometry Backend (Trimesh)

Current Implementation Uses the Trimesh library for geometry generation. It is chosen for lightweight and Python-native, easy cross-platform installation and good integration with the existing stack.

Future Improvements can be made such as other specialized CAD libraries for higher precision.

## Enhancement Opportunities

### Retrieval and RAG Improvements

The retrieval-augmented generation (RAG) module provides basic IFC context.

**Potential Enhancements**:
- Integrate additional data sources:
  - [Official IFC 4x3 Documentation](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/toc.html)
  - [buildingSMART Data Dictionary](https://search.bsdd.buildingsmart.org/)
- Implement custom scripts to fetch and embed data from these resources

## Getting Help

If there are any issues not covered in this guide:

1. Check the [API Reference](./docs/api-reference.md) for tool-specific documentation
2. Review the [Contributing Guidelines](CONTRIBUTING.md) for development setup
3. Search existing GitHub issues for similar problems
4. Create a new issue or a Pull Request.