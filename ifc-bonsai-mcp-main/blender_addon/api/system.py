"""
System/meta API for IFC Bonsai MCP.
Provides command discovery and environment helper introspection for LLMs.
"""

from typing import Dict, Any, List

from . import register_command, get_all_commands


@register_command('list_commands', description="List available addon commands with descriptions")
def list_commands() -> Dict[str, Any]:
    """Return all registered command names and descriptions.

    Returns:
        dict with keys:
        - commands: list of {name, description}
        - count: total number of commands
    """
    registry = get_all_commands()
    cmds = [
        {"name": name, "description": info.get("description")}
        for name, info in registry.items()
    ]
    return {"commands": cmds, "count": len(cmds)}