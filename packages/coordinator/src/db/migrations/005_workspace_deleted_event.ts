/** 005_workspace_deleted_event: the durable event workspace.removed is now workspace.deleted. */
export const sql = `
UPDATE events SET type = 'workspace.deleted' WHERE type = 'workspace.removed';
`;
