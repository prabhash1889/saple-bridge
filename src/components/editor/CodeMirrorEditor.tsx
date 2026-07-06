import React, { useEffect, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeMirrorEditorProps {
  /** Initial document; only re-applied when `filePath` changes (a new file loaded). */
  value: string;
  filePath: string;
  theme: 'light' | 'dark';
  wrap: boolean;
  onChange: (doc: string) => void;
  onSave: () => void;
}

// Lazily load the language support for a file extension. Each pack is a separate
// chunk, so a workspace that only edits Markdown never downloads the Rust grammar.
const loadLanguage = async (filePath: string): Promise<Extension | null> => {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'css':
    case 'scss':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    case 'yaml':
    case 'yml':
      return (await import('@codemirror/lang-yaml')).yaml();
    default:
      return null;
  }
};

export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = ({
  value,
  filePath,
  theme,
  wrap,
  onChange,
  onSave,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  // Keep the latest callbacks reachable from the (stable) editor extensions.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Rebuild the editor whenever the file changes, so undo history never crosses files.
  useEffect(() => {
    if (!hostRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        saveKeymap,
        langCompartment.current.of([]),
        themeCompartment.current.of(theme === 'dark' ? oneDark : []),
        wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();

    let cancelled = false;
    void loadLanguage(filePath).then((lang) => {
      if (cancelled || !lang) return;
      view.dispatch({ effects: langCompartment.current.reconfigure(lang) });
    });

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // `value`/`theme`/`wrap` are applied via the effects below, not by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Live theme swap without losing edits.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? oneDark : []),
    });
  }, [theme]);

  // Live word-wrap toggle.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  return <div className="cm-editor-host" ref={hostRef} />;
};
