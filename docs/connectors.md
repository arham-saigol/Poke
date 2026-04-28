# Connectors

Poke calls MCPs connectors. Connectors are progressively disclosed to the child agent.

The parent agent never receives connector tools. The child receives only `use_github`, `use_notion`, `use_posthog`, or `use_agentmail` when the connector is connected and enabled.

Connector credentials are stored through encrypted secrets.
