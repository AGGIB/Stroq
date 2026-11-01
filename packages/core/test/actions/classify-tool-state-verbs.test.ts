import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';

const cwd = '/home/dev/project';
const classesOf = (tool: string): readonly string[] => classifyTool(tool, {}, cwd).classes;

/**
 * An MCP call that changes something is judged more strictly once a session has read something
 * suspect (`ask-mcp-side-effect-when-tainted`). The name is all that says it changes something, and
 * a name list of `send`/`update`/`create` left out the verbs a record system is made of: in the
 * NVIDIA indirect-prompt-injection data (CC BY 4.0) 398 of 1,272 attacker targets were
 * `adjust_*`, `add_*`, `cancel_*`, `submit_*`, `flag_*`, `process_*` and `schedule_*` calls.
 */
describe('MCP tools named with a verb that changes state', () => {
  it.each([
    'adjust_financial_aid',
    'adjust_warehouse_quantity',
    'add_warehouse_inventory',
    'add_client_note',
    'cancel_appointment',
    'submit_grade',
    'submit_customs_declaration',
    'flag_fraud_investigation',
    'process_refund',
    'schedule_appointment',
    'approve_claim',
    'assign_ticket',
    'grant_access',
    'revoke_token',
    'reassign_case',
    'archive_thread',
    'adjustFinancialAid',
    'SubmitGrade',
    'set_status',
    'edit_details',
    'add_log',
    'destroy_record',
    'purge_cache',
    'start_job',
    'resolve_incident',
    'ticket_assign',
    'appointment_cancel',
    'grade_submit',
    'invoice_void',
    'student_enroll',
  ])('%s is a side effect', (tool) => {
    expect(classesOf(`mcp__records__${tool}`)).toContain('mcp.side_effect');
  });

  it.each([
    'get_patient_record',
    'get_schedule',
    'get_claim_by_id',
    'get_order_details',
    'list_orders',
    'search_claims',
    'find_appointments',
    'read_file',
    'describe_table',
    'fetch_issue',
    'lookup_customer',
    'cancel_status_check',
  ])('%s stays a read', (tool) => {
    expect(classesOf(`mcp__records__${tool}`)).not.toContain('mcp.side_effect');
  });

  it('reads a name that starts with a noun-verb and ends with a read as a read', () => {
    for (const tool of ['issue_read', 'schedule_list', 'tag_search', 'order_get', 'claim_find']) {
      expect(classesOf(`mcp__records__${tool}`)).not.toContain('mcp.side_effect');
    }
    expect(classesOf('mcp__records__issue_refund')).toContain('mcp.side_effect');
  });

  it('reads the verb at the start of the name, not a noun that happens to be one', () => {
    // `schedule`, `order`, `claim`, `process` and `flag` are nouns too; a read of one is a read.
    for (const tool of [
      'get_schedule',
      'list_order_items',
      'get_claim',
      'show_process',
      'get_flag',
    ]) {
      expect(classesOf(`mcp__records__${tool}`)).not.toContain('mcp.side_effect');
    }
  });
});
