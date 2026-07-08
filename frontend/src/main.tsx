import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "./stores/app-store";
import "./index.css";

type BootBridge = {
  markReady: () => void;
  reportError: (title: string, error: unknown) => void;
};

declare global {
  interface Window {
    __DY_BOOT__?: BootBridge;
  }
}

function reportBootError(title: string, error: unknown) {
  window.__DY_BOOT__?.reportError(title, error);
}

function BootReady() {
  useEffect(() => {
    window.__DY_BOOT__?.markReady();
  }, []);

  return null;
}

// Global error boundary to catch React render errors
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    reportBootError("应用渲染出错", [error.message, error.stack].filter(Boolean).join("\n\n"));
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: "40px",
          fontFamily: "system-ui, sans-serif",
          background: "#08080d",
          color: "#e8e8ed",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <h1 style={{ fontSize: "1.2rem", marginBottom: "16px", color: "#ff4757" }}>
            应用加载出错
          </h1>
          <pre style={{
            background: "rgba(255,255,255,0.05)",
            padding: "16px",
            borderRadius: "8px",
            fontSize: "0.8rem",
            maxWidth: "600px",
            overflow: "auto",
            color: "#8b8b9e",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "16px",
              padding: "8px 20px",
              background: "#FE2C55",
              color: "white",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
    <BootReady />
  </ErrorBoundary>
);
