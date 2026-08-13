InfraStudio

AI-native computational design for the built environment.

InfraStudio is an experimental agentic system exploring how AI can reason about, generate, and modify structured building models rather than simply producing images or text.

The core idea is simple:

What happens when AI gets a reliable computational interface to the physical world?

InfraStudio starts with architecture and BIM as a testbed for this question.

Why InfraStudio?

Generative AI has become remarkably capable at producing text, code, images, and even 3D content. But generating a convincing image of a building is fundamentally different from actually constructing a valid computational representation of that building.

Architectural and engineering workflows depend on structured representations containing:

Spaces
Walls
Doors and windows
Floors and roofs
Geometry
Materials
Spatial relationships
Constraints
Building metadata

These relationships need to remain consistent when a design changes.

InfraStudio explores whether AI agents can operate within this structured environment and turn natural-language design intent into executable, verifiable design operations.

Core Concept
Natural Language
       │
       ▼
┌─────────────────────┐
│   Interpreter Agent │
│                     │
│ Understand intent   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Architectural Agent │
│                     │
│ Design reasoning    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│      BIM MCP        │
│                     │
│ Constrained tools   │
│ for BIM operations  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Geometry / BIM Core │
│                     │
│ Deterministic       │
│ execution           │
└──────────┬──────────┘
           │
           ▼
        IFC Model
           │
           ▼
┌─────────────────────┐
│   Quality Review    │
│                     │
│ Validate & critique │
└─────────────────────┘

The important design principle is that the language model does not directly control arbitrary geometry.

Instead, it reasons through a constrained computational interface.

This creates a separation between:

reasoning → tool selection → deterministic execution → validation

Architecture

InfraStudio currently explores a multi-agent architecture.

1. Interpreter Agent

Converts natural-language requirements into structured design requirements.

For example:

"Design a two-storey house with four bedrooms
on a 12m × 20m site."

becomes a structured representation of:

Site constraints
Number of floors
Required spaces
Approximate spatial relationships
Design requirements
2. Architectural Agent

Reasons about the architectural requirements and determines an appropriate design strategy.

It can reason about:

Space planning
Adjacencies
Circulation
Building organization
Design constraints

The goal is not simply to generate a visual concept, but to produce a sequence of computational design operations.

3. BIM MCP Layer

The BIM layer exposes controlled operations to the agents through the Model Context Protocol (MCP).

Rather than allowing an LLM to arbitrarily manipulate a model, the agent interacts with a defined set of operations.

Conceptually:

AI
 │
 ├── create_wall(...)
 ├── create_room(...)
 ├── create_door(...)
 ├── create_window(...)
 ├── create_floor(...)
 ├── modify_element(...)
 └── query_model(...)

This provides a boundary between probabilistic reasoning and deterministic execution.

4. Geometry and BIM Engine

The computational layer executes the requested operations and produces the structured BIM representation.

InfraStudio currently explores IfcOpenShell and Python-based geometry/BIM operations for this purpose.

The objective is to make the resulting model machine-readable, inspectable, and interoperable.

5. Quality Review Agent

Generated designs are evaluated against known requirements and constraints.

The review loop can identify problems and feed them back into the system for another iteration.

Conceptually:

Generate
   ↓
Validate
   ↓
Failure?
 ┌─┴─┐
Yes  No
 │    │
 ▼    ▼
Revise  Complete
 │
 └──────→ Validate

This is an important part of the experiment.

The interesting question isn't only:

Can AI generate a building?

It's:

Can AI recognize when the building it generated is wrong and correct it?

From Generation to Design Search

The longer-term direction is not simply generating one design from a prompt.

A computational design system can potentially explore a design space.

For example:

Design Requirements
        │
        ▼
   Generate N Designs
        │
        ▼
   Evaluate Designs
        │
   ┌────┼────┐
   ▼    ▼    ▼
Cost  Area  Constraints
   │    │    │
   └────┼────┘
        ▼
   Rank / Optimize
        │
        ▼
   Refine Designs

This opens the possibility of moving from:

AI generation

to:

AI-assisted computational exploration

and eventually:

AI-driven design optimization.

Why BIM / IFC?

IFC provides a structured representation of building information rather than a purely visual representation.

This makes it useful as an experimental environment for studying AI interaction with physical systems.

A building can be represented through relationships between:

Project
 ├── Site
 │    └── Building
 │         ├── Storey
 │         │    ├── Space
 │         │    ├── Wall
 │         │    ├── Door
 │         │    └── Window
 │         └── ...

This structure creates an environment in which AI-generated decisions can potentially be queried, modified, checked, and verified.

Research Questions

InfraStudio is currently an engineering and research experiment around several questions:

AI + structured environments

Can language models reliably reason over structured computational representations?

AI + deterministic tools

Does constraining an AI through well-defined computational tools make its output more reliable?

AI + BIM

Can natural-language design intent be translated into valid BIM operations?

Agentic design

Can multiple specialized agents collaborate on a design problem without losing consistency?

Validation

Can AI-generated designs be automatically evaluated against explicit requirements and constraints?

Design exploration

Can AI move beyond generating a single design and instead explore and optimize a design space?

Current Status

InfraStudio is currently an early-stage experimental prototype.

The current work focuses on establishing the technical foundation for:

Natural-language architectural requirements
Agentic design reasoning
BIM tool execution
IFC generation
Structured model manipulation
Automated validation
Iterative design refinement

Many parts of the system are still experimental.

The goal at this stage is not to claim that autonomous architectural design has been solved, but to investigate what computational architecture is required to make it possible.

Technology

Current technologies explored in the project include:

Python
Large Language Models
Agentic AI
Model Context Protocol (MCP)
IfcOpenShell
IFC / BIM
React
WebGL / WASM
Server-Sent Events
Supabase / PostgreSQL
Vector databases / RAG

The stack is expected to evolve as the research progresses.

Vision

InfraStudio starts with architecture, but architecture may only be the first environment in which to test the underlying idea.

The broader question is:

Can AI become capable of reasoning about and operating within computational representations of the physical world?

If successful, the same principles could eventually extend toward:

Architecture
     ↓
Structural Engineering
     ↓
MEP
     ↓
Simulation
     ↓
Optimization
     ↓
Manufacturing
     ↓
Robotics
     ↓
Physical Infrastructure

The long-term vision is to build an AI-native computational layer for physical design and engineering.

A Different Kind of AI

Most generative AI systems operate primarily in information space.

They generate:

Text
Images
Code
Audio
Video

InfraStudio explores a different direction:

AI Reasoning
     ↓
Computational Representation
     ↓
Executable Operations
     ↓
Physical System
     ↓
Validation
     ↓
Feedback

The hypothesis is that connecting increasingly capable reasoning models to structured, verifiable computational environments could enable AI to participate in domains where correctness, constraints, and physical consequences matter.

Project Status

🚧 Experimental / Active Research

InfraStudio is under active development.

The architecture, models, interfaces, and implementation are likely to change substantially as experiments continue.

If you're interested in AI, computational design, BIM, geometry engines, agentic systems, or AI for engineering, contributions and technical discussion are welcome.

The question we're exploring

What happens when AI stops merely describing the physical world and gains the ability to computationally reason about and change it?

InfraStudio is an attempt to find out.
