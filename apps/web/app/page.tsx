"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FilePlus,
  Folder,
  Trash2,
  Github,
  HardDrive,
  KeyRound,
  Mail,
  MemoryStick,
  Moon,
  NotebookText,
  Plug,
  RefreshCw,
  Save,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  Sun,
  UserCircle,
  Wrench
} from "lucide-react";

const connectorIcons: Record<string, React.ComponentType<{ size?: number }>> = {
  github: Github,
  notion: NotebookText,
  posthog: BarChart3,
  agentmail: Mail
};

function getConnectorIcon(name: string): React.ComponentType<{ size?: number }> {
  return connectorIcons[name] ?? Plug;
}

type Section = "chat" | "workspace" | "customize" | "automations" | "memory" | "settings";
type FileNode = { name: string; path: string; type: "file" | "directory"; children?: FileNode[] };
type Session = { id: string; reasoning: string; status: string; messages: Array<{ id: string; role: string; channel: string; content: string; createdAt: string }> };

export default function Page() {
  const [section, setSection] = useState<Section>("chat");
  const [dark, setDark] = useState(true);
  return (
    <main className={dark ? "app dark" : "app"}>
      <aside className="sidebar">
        <div className="brand"><Bot size={24} /><span>Poke</span></div>
        <NavButton active={section === "chat"} icon={<Bot />} label="Chat" onClick={() => setSection("chat")} />
        <NavButton active={section === "workspace"} icon={<HardDrive />} label="Workspace" onClick={() => setSection("workspace")} />
        <NavButton active={section === "customize"} icon={<SlidersHorizontal />} label="Customize" onClick={() => setSection("customize")} />
        <NavButton active={section === "automations"} icon={<CalendarClock />} label="Automations" onClick={() => setSection("automations")} />
        <NavButton active={section === "memory"} icon={<MemoryStick />} label="Memory" onClick={() => setSection("memory")} />
        <div className="spacer" />
        <button className="profile" onClick={() => setSection("settings")}><UserCircle size={28} /><span>Owner</span><ChevronRight size={16} /></button>
        <button className="nav" onClick={() => setDark(!dark)}>{dark ? <Sun /> : <Moon />}<span>{dark ? "Light" : "Dark"}</span></button>
      </aside>
      <section className="content">
        {section === "chat" && <Chat />}
        {section === "workspace" && <FileManager root="workspace" title="Workspace" />}
        {section === "customize" && <Customize />}
        {section === "automations" && <Automations />}
        {section === "memory" && <Memory />}
        {section === "settings" && <SettingsPage />}
      </section>
    </main>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "nav active" : "nav"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function Chat() {
  const [session, setSession] = useState<Session | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    setError(null);
    try {
      setSession(await api("/api/session"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session");
    }
  }
  useEffect(() => { void refresh(); }, []);
  async function send() {
    const text = content.trim();
    if (!text) return;
    setContent("");
    setError(null);
    try {
      setSession(await api("/api/session", { method: "POST", body: JSON.stringify({ content: text }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  }
  return (
    <div className="pane">
      <header className="toolbar">
        <div><h1>Chat</h1><p>Session {session?.id.slice(0, 8) ?? "loading"} · {session?.status ?? "idle"} · {session?.reasoning ?? "low"}</p></div>
        <button className="iconButton" onClick={refresh} title="Refresh" aria-label="Refresh conversations"><RefreshCw size={18} /></button>
      </header>
      {error ? <p className="inlineError">{error}</p> : null}
      <div className="messages">
        {session?.messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="meta">{message.role} · {message.channel}</div>
            <div>{message.content}</div>
          </div>
        ))}
      </div>
      <div className="composer">
        <input value={content} onChange={(event) => setContent((event.currentTarget as HTMLInputElement).value)} onKeyDown={(event) => { if (event.key === "Enter") void send(); }} placeholder="Message Poke or use /new, /abort, /restart, /reasoning low" />
        <button className="primary" onClick={send}><Send size={18} />Send</button>
      </div>
    </div>
  );
}

function FileManager({ root, title }: { root: string; title: string }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [content, setContent] = useState("");
  const [newPath, setNewPath] = useState("");
  const endpoint = `/api/files?root=${root}`;
  async function refresh() { setTree((await api(endpoint)).tree); }
  useEffect(() => { void refresh(); }, [root]);
  async function open(path: string) {
    setSelected(path);
    const result = await api(`${endpoint}&path=${encodeURIComponent(path)}`);
    setContent(result.content ?? "");
  }
  async function save() {
    await api(endpoint, { method: "POST", body: JSON.stringify({ path: selected, content }) });
    await refresh();
  }
  async function createFile() {
    const path = newPath.trim();
    if (!path) return;
    await api(endpoint, { method: "POST", body: JSON.stringify({ path, content: "" }) });
    setNewPath("");
    await refresh();
    await open(path);
  }
  async function remove() {
    if (!selected) return;
    await api(`${endpoint}&path=${encodeURIComponent(selected)}`, { method: "DELETE" });
    setSelected("");
    setContent("");
    await refresh();
  }
  return (
    <div className="split">
      <aside className="subbar">
        <header><h2>{title}</h2></header>
        <FileTree nodes={tree} onOpen={open} />
        <div className="inlineForm">
          <input value={newPath} onChange={(event) => setNewPath((event.currentTarget as HTMLInputElement).value)} placeholder="folder/file.md" />
          <button className="iconButton" onClick={createFile} title="Create file" aria-label="Create file"><FilePlus size={18} /></button>
        </div>
      </aside>
      <section className="editor">
        <div className="toolbar">
          <div><h1>{selected || title}</h1><p>{root}</p></div>
          <div className="actions">
            <button className="iconButton" onClick={refresh} title="Refresh" aria-label="Refresh files"><RefreshCw size={18} /></button>
            <button className="iconButton" onClick={save} disabled={!selected} title="Save" aria-label="Save file"><Save size={18} /></button>
            <button className="iconButton" onClick={remove} disabled={!selected} title="Delete" aria-label="Delete file"><Trash2 size={18} /></button>
            {selected
              ? <a className="iconButton" href={`${endpoint}&path=${encodeURIComponent(selected)}&download=1`} title="Download" aria-label="Download file"><Download size={18} /></a>
              : <button className="iconButton" type="button" disabled aria-disabled="true" title="Download (select a file)" aria-label="Download (no file selected)"><Download size={18} /></button>
            }
          </div>
        </div>
        <textarea value={content} onChange={(event) => setContent((event.currentTarget as HTMLTextAreaElement).value)} placeholder="Select a file" />
      </section>
    </div>
  );
}

function FileTree({ nodes, onOpen }: { nodes: FileNode[]; onOpen: (path: string) => void }) {
  return <div>{nodes.map((node) => <div key={node.path} className="treeItem">
    <button onClick={() => node.type === "file" && onOpen(node.path)}>{node.type === "directory" ? <Folder size={16} /> : <File size={16} />}<span>{node.name}</span></button>
    {node.children && <div className="treeChildren"><FileTree nodes={node.children} onOpen={onOpen} /></div>}
  </div>)}</div>;
}

function Customize() {
  const [tab, setTab] = useState<"skills" | "connectors">("skills");
  return (
    <div className="split">
      <aside className="subbar">
        <button className={tab === "skills" ? "nav active" : "nav"} onClick={() => setTab("skills")}><Wrench />Skills</button>
        <button className={tab === "connectors" ? "nav active" : "nav"} onClick={() => setTab("connectors")}><Plug />Connectors</button>
      </aside>
      {tab === "skills" ? <FileManager root="skills" title="Skills" /> : <Connectors />}
    </div>
  );
}

function Connectors() {
  const [items, setItems] = useState<any[]>([]);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  async function refresh() { setItems((await api("/api/connectors")).connectors); }
  useEffect(() => { void refresh(); }, []);
  return <section className="pane"><header className="toolbar"><div><h1>Connectors</h1><p>Progressive tools for the child agent</p></div></header>
    <div className="grid">{items.map((item) => {
      const Icon = getConnectorIcon(item.name);
      return <article className="card" key={item.name}>
      <div className="cardTitle"><Icon size={18} />{item.displayName}</div>
      <p>{item.authType === "oauth" ? "OAuth connector" : "API key connector"} · {item.status}</p>
      <input value={credentials[item.name] ?? ""} onChange={(event) => setCredentials({ ...credentials, [item.name]: (event.currentTarget as HTMLInputElement).value })} placeholder={item.authType === "oauth" ? "OAuth token placeholder" : "API key"} />
      <button className="primary" onClick={async () => { await api("/api/connectors", { method: "POST", body: JSON.stringify({ name: item.name, enabled: !item.enabled, credential: credentials[item.name] }) }); await refresh(); }}>
        <Check size={16} />{item.enabled ? "Disable" : "Enable"}
      </button>
    </article>;
    })}</div>
  </section>;
}

function Automations() {
  const [items, setItems] = useState<any[]>([]);
  const [raw, setRaw] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  async function refresh() {
    const data = await api("/api/automations");
    setItems(data.automations);
    setRaw(JSON.stringify(data.automations, null, 2));
  }
  async function save() {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
      return;
    }
    setJsonError(null);
    await api("/api/automations", { method: "POST", body: JSON.stringify({ automations: parsed }) });
    await refresh();
  }
  useEffect(() => { void refresh(); }, []);
  return <section className="pane"><header className="toolbar"><div><h1>Automations</h1><p>Scheduled command and prompt runs</p></div></header>
    <div className="automationLayout">
      <div className="grid">{items.map((item) => <article className="card" key={item.name}>
        <div className="cardTitle"><CalendarClock size={18} />{item.name}</div>
        <p>{item.description}</p>
        <code>{item.schedule.type}: {item.schedule.value}</code>
      </article>)}</div>
      <section className="editor compactEditor">
        <div className="toolbar"><div><h2>automations.json</h2><p>Validated before save</p></div><button className="iconButton" onClick={save} title="Save" aria-label="Save automations"><Save size={18} /></button></div>
        {jsonError ? <p className="inlineError">{jsonError}</p> : null}
        <textarea value={raw} onChange={(event) => setRaw((event.currentTarget as HTMLTextAreaElement).value)} />
      </section>
    </div>
  </section>;
}

function Memory() {
  return <FileManager root="memory" title="Memory" />;
}

function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [name, setName] = useState("");
  const [allowedWhatsAppNumber, setAllowedWhatsAppNumber] = useState("");
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [revealMap, setRevealMap] = useState<Record<string, boolean>>({});
  const secretKeys = ["openaiApiKey", "exaApiKey", "exaBackupApiKey", "vercelAiGatewayApiKey", "deepgramApiKey"] as const;
  useEffect(() => { void api("/api/settings").then((data) => { setSettings(data); setName(data.profile?.name ?? ""); }); }, []);
  useEffect(() => {
    if (!settings) return;
    setAllowedWhatsAppNumber(settings.config?.channels?.whatsapp?.allowedNumber ?? "");
    setWhatsappEnabled(Boolean(settings.config?.channels?.whatsapp?.enabled));
  }, [settings]);
  async function save() {
    const payload: Record<string, unknown> = {
      name,
      allowedWhatsAppNumber,
      whatsappEnabled
    };
    for (const key of secretKeys) {
      const value = keys[key];
      if (typeof value === "string" && value.length > 0) {
        payload[key] = value;
      }
    }
    setSettings(await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    }));
  }
  return <section className="pane"><header className="toolbar"><div><h1>Settings</h1><p>Identity, providers, WhatsApp, and pipeline models</p></div><Settings /></header>
    <div className="settingsGrid">
      <label>Name<input value={name} onChange={(event) => setName((event.currentTarget as HTMLInputElement).value)} /></label>
      <article className="card"><div className="cardTitle"><KeyRound size={18} />External APIs</div><p>Keys are encrypted at rest.</p>
        {secretKeys.map((key) => <div className="secretField" key={key}>
          <input
            type={revealMap[key] ? "text" : "password"}
            value={keys[key] ?? ""}
            onChange={(event) => setKeys({ ...keys, [key]: (event.currentTarget as HTMLInputElement).value })}
            placeholder={key}
          />
          <button
            className="iconButton"
            type="button"
            onClick={() => setRevealMap({ ...revealMap, [key]: !revealMap[key] })}
            title={revealMap[key] ? `Hide ${key}` : `Reveal ${key}`}
            aria-label={revealMap[key] ? `Hide ${key}` : `Reveal ${key}`}
          >
            {revealMap[key] ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>)}
      </article>
      <article className="card"><div className="cardTitle"><Plug size={18} />WhatsApp</div><p>Adapter: Baileys · Connected: {settings?.whatsapp?.connected ? "yes" : "no"}</p>
        <label><input type="checkbox" checked={whatsappEnabled} onChange={(event) => setWhatsappEnabled((event.currentTarget as HTMLInputElement).checked)} /> Enabled</label>
        <input value={allowedWhatsAppNumber} onChange={(event) => setAllowedWhatsAppNumber((event.currentTarget as HTMLInputElement).value)} placeholder="Allowed WhatsApp number" />
        <p>{settings?.whatsapp?.instructions}</p>
      </article>
      <button className="primary" onClick={save}><Save size={18} />Save Settings</button>
    </div>
  </section>;
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
