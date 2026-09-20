export interface Project {
  id: string;
  name: string;
  path: string;
  gitRemote: string | null;
  createdAt: string;
  lastCheckedAt?: string | null;
  lastHeadHash?: string | null;
  lastWorkingTreeClean?: boolean;
  gitStatus?: 'unknown' | 'ok' | 'not-repository' | 'unavailable';
  lastChangedFiles?: number;
  lastUntrackedFiles?: number;
  pathExists?: boolean;
}

export interface NewProject {
  name: string;
  path: string;
  gitRemote?: string | null;
}

export type EntrySource = 'manual' | 'auto';

export interface Entry {
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  source: EntrySource;
  createdAt: string;
  updatedAt: string;
}

export interface NewEntry {
  projectId: string;
  title: string;
  bodyMd?: string;
  source?: EntrySource;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  title: string;
  note: string;
  workingOn: string;
  currentWorks: string;
  brokenOrUnfinished: string;
  tryingToUnderstand: string;
  decisionsMade: string;
  alternativesRejected: string;
  openQuestions: string;
  nextStep: string;
  createdAt: string;
}

export interface NewCheckpoint {
  projectId: string;
  title: string;
  note?: string;
  workingOn?: string;
  currentWorks?: string;
  brokenOrUnfinished?: string;
  tryingToUnderstand?: string;
  decisionsMade?: string;
  alternativesRejected?: string;
  openQuestions?: string;
  nextStep?: string;
  commitHashes?: string[];
  filePaths?: string[];
  entryIds?: string[];
  researchIds?: string[];
}

export type DecisionStatus = 'active' | 'superseded' | 'rejected' | 'experimental';

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  status: DecisionStatus;
  reason: string;
  notes: string;
  parentDecisionId: string | null;
  replacementDecisionId: string | null;
  checkpointId: string | null;
  temporary: boolean;
  revisitCondition: string;
  revisitDate: string | null;
  reviewStatus: 'pending' | 'reviewed' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface NewDecision {
  projectId: string;
  title: string;
  status?: DecisionStatus;
  reason?: string;
  notes?: string;
  parentDecisionId?: string | null;
  replacementDecisionId?: string | null;
  checkpointId?: string | null;
  temporary?: boolean;
  revisitCondition?: string;
  revisitDate?: string | null;
  reviewStatus?: 'pending' | 'reviewed' | 'dismissed';
  commitHashes?: string[];
  filePaths?: string[];
  entryIds?: string[];
  researchIds?: string[];
  assumptionIds?: string[];
}

export interface MemoryRelations {
  commitHashes: string[];
  filePaths: string[];
  entryIds: string[];
  researchIds: string[];
  assumptionIds?: string[];
}

export interface ResumeContext {
  lastActiveAt: string;
  inactiveDays: number;
  latestCheckpoint: Checkpoint | null;
  activeDecisions: Decision[];
  recentEntries: Entry[];
  commitsSinceCheckpoint: number;
  changedFiles: number;
  researchCount: number;
  experimentCount?: number;
  runningExperiments?: Experiment[];
  suggestedNextStep: string;
}

export interface MemoryTimelineItem {
  id: string;
  projectId: string;
  kind: 'journal' | 'checkpoint' | 'decision' | 'research' | 'experiment' | 'assumption';
  title: string;
  occurredAt: string;
}

export type ResearchItemType = 'pdf' | 'link' | 'image' | 'video' | 'note';

export interface ResearchItem {
  id: string;
  projectId: string;
  type: ResearchItemType;
  title: string;
  pathOrUrl: string | null;
  notes: string;
  createdAt: string;
}

export interface NewResearchItem {
  projectId: string;
  type: ResearchItemType;
  title: string;
  pathOrUrl?: string | null;
  notes?: string;
  entryIds?: string[];
}

export interface XrayMemoryLink {
  kind: 'journal' | 'checkpoint' | 'decision' | 'research' | 'experiment' | 'assumption';
  id: string;
  title: string;
}

export type AssumptionStatus = 'active' | 'questioned' | 'invalidated';

export interface Assumption {
  id: string;
  projectId: string;
  statement: string;
  status: AssumptionStatus;
  notes: string;
  createdAt: string;
  invalidatedAt: string | null;
}

export interface NewAssumption {
  projectId: string;
  statement: string;
  status?: AssumptionStatus;
  notes?: string;
}

export type ExperimentStatus = 'planned' | 'running' | 'successful' | 'failed' | 'inconclusive' | 'abandoned';

export interface Experiment {
  id: string;
  projectId: string;
  title: string;
  hypothesis: string;
  tested: string;
  method: string;
  result: string;
  conclusion: string;
  status: ExperimentStatus;
  experimentDate: string;
  resultingDecisionId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  commitHashes?: string[];
  filePaths?: string[];
  entryIds?: string[];
  researchIds?: string[];
  assumptionIds?: string[];
}

export interface NewExperiment {
  projectId: string;
  title: string;
  hypothesis?: string;
  tested?: string;
  method?: string;
  result?: string;
  conclusion?: string;
  status?: ExperimentStatus;
  experimentDate?: string;
  resultingDecisionId?: string | null;
  notes?: string;
  commitHashes?: string[];
  filePaths?: string[];
  entryIds?: string[];
  researchIds?: string[];
  assumptionIds?: string[];
}

export interface DependencyNode {
  id: string;
  name: string;
  version: string;
  direct: boolean;
  directKind: 'runtime' | 'development' | 'optional' | null;
  resolved: boolean;
  children: string[];
  parentIds: string[];
  usedBy: string[];
  transitiveCount: number;
  memoryLinks: XrayMemoryLink[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  source: 'package-lock.json';
  confirmed: true;
}

export interface ProjectXrayReport {
  ecosystem: 'npm' | 'none';
  manifestPath: string | null;
  lockfilePath: string | null;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  rootDependencyIds: string[];
  warnings: string[];
}

export interface XrayRemovalSimulation {
  dependencyId: string;
  confirmedSourceFiles: string[];
  confirmedRelationships: string[];
  affectedBranchIds: string[];
  possiblyRemovableIds: string[];
  possibleImpact: string[];
}
