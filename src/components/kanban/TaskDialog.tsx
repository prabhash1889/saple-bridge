import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Task, AgentConfig, useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useProviderStore } from '../../stores/providerStore';
import type { AgentProvider } from '../../types/provider';
import { ModelCombobox } from '../common/ModelCombobox';
import type { TaskPriority } from '../../types/task';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface TaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  taskToEdit?: Task | null;
}

const TEMPLATE_PRESETS = [
  { id: 'custom', label: 'Custom Agent' },
  { id: 'bug_fix', label: 'Bug Fixer' },
  { id: 'feature_build', label: 'Feature Builder' },
  { id: 'code_review', label: 'Code Reviewer' },
  { id: 'refactor', label: 'Code Architect (Refactor)' },
  { id: 'test_generation', label: 'Test Generator' },
  { id: 'documentation', label: 'Documentation Writer' },
  { id: 'investigation', label: 'Scout / Investigator' },
];

const ROLE_PROMPTS: Record<string, { role: AgentConfig['role']; prompt: string }> = {
  custom: {
    role: 'builder',
    prompt: 'You are an autonomous development builder. Follow instructions carefully.',
  },
  bug_fix: {
    role: 'builder',
    prompt: 'You are an autonomous bug fixing agent. Locate the root cause of the described issue, resolve it safely, write regression unit tests, and check that all tests pass successfully.',
  },
  feature_build: {
    role: 'builder',
    prompt: 'You are an autonomous feature builder. Implement the requested feature, write descriptive code comments, structure modules cleanly, write unit tests, and verify overall code correctness.',
  },
  code_review: {
    role: 'reviewer',
    prompt: 'You are an expert code quality and security reviewer. Analyze the specified files, check for vulnerabilities (OWASP top 10), logical errors, performance bottlenecks, and style inconsistencies.',
  },
  refactor: {
    role: 'builder',
    prompt: 'You are an expert code refactoring agent. Restructure the target modules for better readability, modularity, and performance. Do not alter functional behaviors. Ensure existing tests pass.',
  },
  test_generation: {
    role: 'builder',
    prompt: 'You are an autonomous test generation agent. Review the codebase to identify missing tests, write comprehensive unit and integration tests, and run them to ensure coverage is added.',
  },
  documentation: {
    role: 'builder',
    prompt: 'You are an autonomous technical writer. Update the documentation, READMEs, API specs, and inline code comments to reflect the current codebase implementation and usage guides.',
  },
  investigation: {
    role: 'scout',
    prompt: 'You are an autonomous scout. Investigate the codebase, search for relevant files, locate modules or APIs, and write a summary explaining your findings without making code changes.',
  },
};

export const TaskDialog: React.FC<TaskDialogProps> = ({ isOpen, onClose, taskToEdit }) => {
  const { currentProjectPath } = useProjectStore();
  const { addTask, updateTask } = useKanbanStore();
  const { providers } = useProviderStore();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState('');
  const [template, setTemplate] = useState('custom');
  
  // Extended fields
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [dueDate, setDueDate] = useState('');
  const [checklist, setChecklist] = useState('');
  const [targetFiles, setTargetFiles] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  
  // Agent configuration
  const [agentRole, setAgentRole] = useState<AgentConfig['role']>('builder');
  const [agentProvider, setAgentProvider] = useState<AgentProvider>('codex');
  const [agentModel, setAgentModel] = useState('default');
  const [agentPrompt, setAgentPrompt] = useState(ROLE_PROMPTS.custom.prompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen, onClose);

  const enabledProviders = providers.filter((p) => p.enabled);

  useEffect(() => {
    if (taskToEdit) {
      setTitle(taskToEdit.title);
      setDescription(taskToEdit.description);
      setLabels(taskToEdit.labels.join(', '));
      setTemplate(taskToEdit.template || 'custom');
      setPriority(taskToEdit.priority || 'normal');
      setDueDate(taskToEdit.dueDate || '');
      setChecklist(taskToEdit.checklist?.map((item) => item.text).join('\n') || '');
      setTargetFiles(taskToEdit.targetFiles?.join(', ') || '');
      setAcceptanceCriteria(taskToEdit.acceptanceCriteria?.join('\n') || '');
      
      if (taskToEdit.agentConfig) {
        setAgentRole(taskToEdit.agentConfig.role);
        setAgentProvider(taskToEdit.agentConfig.provider || 'codex');
        setAgentModel(taskToEdit.agentConfig.model);
        setAgentPrompt(taskToEdit.agentConfig.systemPrompt);
      }
    } else {
      setTitle('');
      setDescription('');
      setLabels('');
      setTemplate('custom');
      setPriority('normal');
      setDueDate('');
      setChecklist('');
      setTargetFiles('');
      setAcceptanceCriteria('');
      setAgentRole(ROLE_PROMPTS.custom.role);
      setAgentProvider('codex');
      setAgentModel('default');
      setAgentPrompt(ROLE_PROMPTS.custom.prompt);
    }
  }, [taskToEdit, isOpen]);

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const prov = e.target.value as AgentProvider;
    setAgentProvider(prov);
    
    const pConfig = providers.find((p) => p.provider === prov);
    if (pConfig) {
      setAgentModel(pConfig.customModel || pConfig.defaultModel || '');
    }
  };

  // Update prompt and role when template selection changes
  const handleTemplateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedTemplate = e.target.value;
    setTemplate(selectedTemplate);
    
    const preset = ROLE_PROMPTS[selectedTemplate];
    if (preset) {
      setAgentRole(preset.role);
      setAgentPrompt(preset.prompt);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProjectPath || !title.trim()) return;

    const parsedLabels = labels
      .split(',')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const parsedTargetFiles = targetFiles
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0);

    const parsedAcceptanceCriteria = acceptanceCriteria
      .split('\n')
      .map(c => c.trim())
      .filter(c => c.length > 0);

    // Checklist is edited as plain lines; done state carries over for lines whose
    // text is unchanged, new/edited lines start unchecked.
    const previousChecklist = taskToEdit?.checklist || [];
    const parsedChecklist = checklist
      .split('\n')
      .map(c => c.trim())
      .filter(c => c.length > 0)
      .map(text => ({
        text,
        done: previousChecklist.find(item => item.text === text)?.done ?? false,
      }));

    const agentConfig: AgentConfig = {
      role: agentRole,
      model: agentModel,
      systemPrompt: agentPrompt,
      provider: agentProvider,
    };

    if (taskToEdit) {
      await updateTask(currentProjectPath, taskToEdit.id, {
        title,
        description,
        labels: parsedLabels,
        template,
        priority,
        dueDate: dueDate || undefined,
        checklist: parsedChecklist.length > 0 ? parsedChecklist : undefined,
        targetFiles: parsedTargetFiles,
        acceptanceCriteria: parsedAcceptanceCriteria,
        agentConfig,
      });
    } else {
      await addTask(currentProjectPath, {
        title,
        description,
        column: 'backlog',
        priority,
        dueDate: dueDate || undefined,
        checklist: parsedChecklist.length > 0 ? parsedChecklist : undefined,
        labels: parsedLabels,
        template,
        targetFiles: parsedTargetFiles,
        acceptanceCriteria: parsedAcceptanceCriteria,
        agentConfig,
      });
    }
    
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="task-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="task-dialog-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-dialog-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="task-dialog-header">
          <h3 id="task-dialog-title">{taskToEdit ? 'Edit Task' : 'Create Task'}</h3>
          <button
            onClick={onClose}
            className="icon-button"
            title="Close task dialog"
            aria-label="Close task dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="task-dialog-form">
          <div className="task-dialog-fields">
            {/* Title */}
            <div className="task-dialog-field">
              <label>Task Title</label>
              <input 
                required
                value={title} 
                onChange={e => setTitle(e.target.value)} 
                placeholder="Name of feature or bug to solve..."
              />
            </div>

            {/* Description */}
            <div className="task-dialog-field">
              <label>Description / Requirements</label>
              <textarea 
                rows={3}
                value={description} 
                onChange={e => setDescription(e.target.value)} 
                placeholder="Provide detailed description of what needs to be coded..."
              />
            </div>

            {/* Priority & Labels */}
            <div className="task-dialog-row">
              <div className="task-dialog-field">
                <label>Priority</label>
                <select 
                  value={priority} 
                  onChange={e => setPriority(e.target.value as TaskPriority)}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div className="task-dialog-field">
                <label>Due Date (optional)</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                />
              </div>
            </div>

            {/* Labels */}
            <div className="task-dialog-field">
              <label>Labels (comma separated)</label>
              <input
                value={labels}
                onChange={e => setLabels(e.target.value)}
                placeholder="e.g. backend, auth, ui"
              />
            </div>

            {/* Checklist */}
            <div className="task-dialog-field">
              <label>Checklist (one item per line)</label>
              <textarea
                rows={3}
                value={checklist}
                onChange={e => setChecklist(e.target.value)}
                placeholder="e.g. Write migration&#10;Update docs"
              />
            </div>

            {/* Target Files */}
            <div className="task-dialog-field">
              <label>Target Files (comma separated)</label>
              <input 
                value={targetFiles} 
                onChange={e => setTargetFiles(e.target.value)} 
                placeholder="e.g. src/App.tsx, src/index.css"
              />
            </div>

            {/* Acceptance Criteria */}
            <div className="task-dialog-field">
              <label>Acceptance Criteria (one per line)</label>
              <textarea 
                rows={3}
                value={acceptanceCriteria} 
                onChange={e => setAcceptanceCriteria(e.target.value)} 
                placeholder="e.g. Test compiles successfully&#10;Page renders without errors"
              />
            </div>

            <div className="task-dialog-divider" />

            {/* Agent Template */}
            <div className="task-dialog-row">
              <div className="task-dialog-field">
                <label>Agent Type / Template</label>
                <select 
                  value={template} 
                  onChange={handleTemplateChange}
                >
                  {TEMPLATE_PRESETS.map(preset => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="task-dialog-field">
                <label>Agent Role</label>
                <select 
                  value={agentRole} 
                  onChange={e => setAgentRole(e.target.value as AgentConfig['role'])}
                >
                  <option value="builder">Builder</option>
                  <option value="scout">Scout</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="coordinator">Coordinator</option>
                </select>
              </div>
            </div>

            {/* Provider and Model selection */}
            <div className="task-dialog-row">
              <div className="task-dialog-field">
                <label>AI Agent Provider</label>
                <select 
                  value={agentProvider} 
                  onChange={handleProviderChange}
                >
                  {enabledProviders.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="task-dialog-field">
                <label>LLM Model</label>
                {/* Combobox (P8): aliases + recents + live discovery, still free-text. 'default'
                    omits the --model flag so the CLI runs its own current model. */}
                <ModelCombobox
                  provider={agentProvider}
                  value={agentModel}
                  onChange={setAgentModel}
                />
              </div>
            </div>

            {/* System Prompt */}
            <div className="task-dialog-field">
              <label>Agent Instructions (System Prompt)</label>
              <textarea 
                rows={3}
                value={agentPrompt} 
                onChange={e => setAgentPrompt(e.target.value)} 
                placeholder="Enter system prompts for agent..."
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="task-dialog-footer">
            <button type="button" onClick={onClose} className="secondary-action">
              Cancel
            </button>
            <button type="submit" className="primary">
              {taskToEdit ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
