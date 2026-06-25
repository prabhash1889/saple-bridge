import React from 'react';
import { FileTree } from '../files/FileTree';
import { CodeViewer } from './CodeViewer';

export const EditorPanel: React.FC = () => {
  return (
    <div className="editor-room-layout">
      <FileTree />
      <div className="editor-room-main">
        <CodeViewer />
      </div>
    </div>
  );
};
