# InfraStudio

### AI-native computational design for the built environment.

InfraStudio is an experimental agentic system exploring how AI can **reason about, generate, modify, and validate structured building models** rather than simply producing images or text.

The core idea is simple:

> **What happens when AI gets a reliable computational interface to the physical world?**

InfraStudio starts with architecture and BIM as a testbed for exploring this question.

---

## Why InfraStudio?

Generative AI has become remarkably capable at producing text, code, images, and other forms of content.

But generating a convincing image of a building is fundamentally different from actually constructing a **valid computational representation** of that building.

Architectural and engineering workflows depend on structured representations containing:

- Spaces
- Walls
- Doors and windows
- Floors and roofs
- Geometry
- Materials
- Spatial relationships
- Constraints
- Building metadata

These relationships must remain consistent as a design changes.

InfraStudio explores whether AI agents can operate within this structured environment and transform natural-language design intent into executable, verifiable design operations.

---

# Core Concept

```mermaid
flowchart TD
    A["Natural Language Design Intent"] --> B["Interpreter Agent"]
    B --> C["Architectural Agent"]
    C --> D["BIM MCP Layer"]
    D --> E["Deterministic BIM / Geometry Engine"]
    E --> F["IFC / BIM Model"]
    F --> G["Quality Review Agent"]
    G --> H{"Valid?"}
    H -->|Yes| I["Completed Design"]
    H -->|No| J["Revise"]
    J --> C
