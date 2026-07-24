import React, { useEffect, useState } from "react";
import { useApiCredential } from "../lib/api-credential";

/**
 * Tab-scoped API credential control. The key is masked, never placed in a URL,
 * and cleared automatically when the browser tab/session ends.
 */
export const ApiCredentialControl: React.FC = () => {
  const { apiKey, setApiKey, clearApiKey } = useApiCredential();
  const [draft, setDraft] = useState(apiKey);

  useEffect(() => setDraft(apiKey), [apiKey]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setApiKey(draft);
      }}
      style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}
    >
      <label style={{ fontSize: 12, color: "#9ca3af" }}>
        <span style={{ marginRight: 6 }}>Session API key</span>
        <input
          aria-label="Session API key"
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Paste X-API-Key"
          style={{
            width: 180,
            padding: "6px 8px",
            color: "#e5e7eb",
            background: "#030712",
            border: "1px solid #4b5563",
            borderRadius: 4,
          }}
        />
      </label>
      <button type="submit" disabled={!draft.trim()} style={buttonStyle}>
        Use for tab
      </button>
      {apiKey && (
        <button
          type="button"
          onClick={() => {
            clearApiKey();
            setDraft("");
          }}
          style={buttonStyle}
        >
          Clear
        </button>
      )}
    </form>
  );
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: 4,
  border: "1px solid #4b5563",
  color: "#e5e7eb",
  background: "#1f2937",
  cursor: "pointer",
  fontSize: 12,
};

export default ApiCredentialControl;
