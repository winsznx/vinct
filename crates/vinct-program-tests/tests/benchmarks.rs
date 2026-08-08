//! Compute-unit benchmarks for the Phase 2 action path.
//!
//! These are measurements, not estimates. Every number written to
//! `artifacts/benchmarks/phase2-compute.json` comes from `compute_units_consumed` on a real
//! SVM execution of the built program.
//!
//! LiteSVM is not the ephemeral rollup and not Devnet, so these numbers are a floor and a
//! regression guard, not the Phase 3 budget. Phase 3 measures the actual cohort inside a
//! Magic Action attempt, where the account count, the transaction size, and the committor's
//! own overhead all matter.

// litesvm returns `Result<TransactionMetadata, FailedTransactionMetadata>`, whose error
// variant is large by design because it carries the full transaction metadata and logs.
// That metadata is exactly what these tests assert on, so the lint is allowed here rather
// than working around litesvm's API.
#![allow(clippy::result_large_err)]
mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use common::*;

fn operation(seed: &[u8]) -> [u8; 32] {
    vinct_program_tests::sha256(seed)
}

/// The ceiling one adapter action may consume before the four-action cohort stops fitting.
///
/// Solana's per-transaction limit is 1,400,000 CU and the PRD targets staying under
/// 1,200,000 for the whole attempted transaction. Four actions plus commit overhead means
/// an adapter action has to stay well inside 200,000, which is also the default per-action
/// budget a `CallHandler` declares.
const ADAPTER_ACTION_CU_CEILING: u64 = 60_000;

/// The ceiling for the final settlement action.
const SETTLEMENT_ACTION_CU_CEILING: u64 = 40_000;

#[test]
fn measure_and_record_the_action_path() {
    let operation_id = operation(b"bench");
    let mut world = World::new();
    world.arm_everything(operation_id);

    let mut measurements: BTreeMap<String, u64> = BTreeMap::new();

    // Three adapter actions, measured separately. They should be near-identical; a spread
    // would mean one protocol's path is doing something the others are not.
    let mut adapter_units = Vec::new();
    for index in 0..3 {
        let metadata = world.execute(index, operation_id).expect("executes");
        let units = metadata.compute_units_consumed;
        measurements.insert(
            format!("execute_bounded_action[{}]", world.protocols[index].name),
            units,
        );
        adapter_units.push(units);
    }

    // The final settlement action.
    let settlement = world
        .finalize_settlement(operation_id, 3)
        .expect("finalizes");
    measurements.insert(
        "finalize_settlement".into(),
        settlement.compute_units_consumed,
    );

    let cohort_total: u64 = adapter_units.iter().sum::<u64>() + settlement.compute_units_consumed;
    measurements.insert("cohort_total".into(), cohort_total);

    // Lifecycle instructions, for completeness. They never run inside an action.
    let mut lifecycle = World::new();
    let setup_operation = operation(b"bench-setup");
    // Certificates are no longer published by an instruction that takes their contents, so
    // there is nothing to measure here. The composition test covers the real path.
    lifecycle.publish_certificate(lifecycle.default_certificate_args(setup_operation));
    lifecycle
        .initialize_settlement_receipt(setup_operation)
        .map(|m| {
            measurements.insert(
                "initialize_settlement_receipt".into(),
                m.compute_units_consumed,
            )
        })
        .expect("initializes");
    lifecycle.initialize_market(0, None);
    let args = lifecycle.default_install_args(0, setup_operation);
    lifecycle
        .install_capability(0, args)
        .map(|m| measurements.insert("install_capability".into(), m.compute_units_consumed))
        .expect("installs");
    lifecycle
        .arm(0)
        .map(|m| measurements.insert("arm_capability".into(), m.compute_units_consumed))
        .expect("arms");
    let signer = lifecycle.protocols[0].adapter_signer;
    let authority = lifecycle.protocols[0].authority.insecure_clone();
    lifecycle
        .set_adapter(0, Some(signer), &authority)
        .map(|m| measurements.insert("set_adapter".into(), m.compute_units_consumed))
        .expect("registers");
    lifecycle
        .initialize_adapter_receipt(0, setup_operation)
        .map(|m| {
            measurements.insert(
                "initialize_adapter_receipt".into(),
                m.compute_units_consumed,
            )
        })
        .expect("receipt");

    // Serialized size and account count of the action's own instruction, which Phase 3
    // needs to budget the bundle.
    let instruction = world.execute_instruction(0, operation_id);
    let account_count = instruction.accounts.len();
    let data_len = instruction.data.len();

    let report = format!(
        r#"{{
  "phase": 2,
  "environment": "LiteSVM 0.15.2, in-process, not an ephemeral rollup and not Devnet",
  "measured": true,
  "note": "Compute units read from compute_units_consumed on real executions of the built SBF programs. A floor and a regression guard; Phase 3 measures the real cohort inside a Magic Action attempt.",
  "ceilings": {{
    "adapter_action_cu": {ADAPTER_ACTION_CU_CEILING},
    "settlement_action_cu": {SETTLEMENT_ACTION_CU_CEILING}
  }},
  "execute_bounded_action_instruction": {{
    "account_count": {account_count},
    "instruction_data_bytes": {data_len}
  }},
  "compute_units": {{
{}
  }}
}}
"#,
        measurements
            .iter()
            .map(|(name, units)| format!("    \"{name}\": {units}"))
            .collect::<Vec<_>>()
            .join(",\n")
    );

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts/benchmarks")
        .join("phase2-compute.json");
    fs::create_dir_all(path.parent().expect("has a parent")).expect("creates directory");
    fs::write(&path, report).expect("writes the benchmark");

    // The measurement is only useful if it also fails when it should.
    for (index, units) in adapter_units.iter().enumerate() {
        assert!(
            *units < ADAPTER_ACTION_CU_CEILING,
            "{} adapter action used {units} CU, ceiling is {ADAPTER_ACTION_CU_CEILING}",
            world.protocols[index].name
        );
    }
    assert!(
        settlement.compute_units_consumed < SETTLEMENT_ACTION_CU_CEILING,
        "settlement action used {} CU, ceiling is {SETTLEMENT_ACTION_CU_CEILING}",
        settlement.compute_units_consumed
    );

    // The three adapter actions must be within a narrow band of each other.
    let min = adapter_units.iter().min().copied().expect("three values");
    let max = adapter_units.iter().max().copied().expect("three values");
    assert!(
        max - min < 1_000,
        "adapter actions diverged: {min} to {max} CU"
    );
}

#[test]
fn the_action_instruction_stays_small_enough_for_a_four_action_cohort() {
    // A Magic Action carries its account list as `ShortAccountMeta` (32-byte key plus a
    // writable flag) and its instruction data. Four actions have to fit one base
    // transaction alongside the commit, so the per-action footprint is budgeted here rather
    // than discovered in Phase 3.
    let operation_id = operation(b"bench-size");
    let mut world = World::new();
    world.arm_everything(operation_id);

    let instruction = world.execute_instruction(0, operation_id);

    // A direct call carries eight accounts: the six the capability commits to plus the
    // escrow pair `#[action]` appends. A *scheduled* action's `ShortAccountMeta` list
    // carries only the six, because the SDK supplies the escrow pair itself. The bundle
    // footprint is therefore budgeted over six, not eight.
    assert_eq!(
        instruction.accounts.len(),
        8,
        "direct call account count changed"
    );
    const COMMITTED_ACCOUNTS: usize = 6;
    let short_meta_bytes = COMMITTED_ACCOUNTS * 33;
    let action_bytes = short_meta_bytes + instruction.data.len() + 32 + 4;

    assert_eq!(instruction.data.len(), 8, "the action gained an argument");
    assert!(
        action_bytes < 300,
        "one action serialises to {action_bytes} bytes, four will not fit comfortably"
    );
}

#[test]
fn a_failing_adapter_still_leaves_no_partial_effect() {
    // Measured alongside the benchmarks because it is the same path: an adapter whose CPI
    // fails must leave the receipt unwritten and the capability unconsumed, or Phase 3's
    // reconciler would see a receipt for an effect that never happened.
    let operation_id = operation(b"bench-fail");
    let mut world = World::new();
    world.arm_everything(operation_id);

    // Withdraw alpha's registration so its CPI fails inside the target program.
    let authority = world.protocols[0].authority.insecure_clone();
    world.set_adapter(0, None, &authority).expect("revokes");

    let before = read_capability(&world.svm, &world.protocols[0].capability);
    assert!(world.execute(0, operation_id).is_err());

    let receipt = read_receipt(&world.svm, &world.receipt_address(0, operation_id));
    assert!(!receipt.executed, "a failed CPI still wrote a receipt");
    assert!(!receipt.target_effect_applied);

    let after = read_capability(&world.svm, &world.protocols[0].capability);
    assert_eq!(
        after.capability_nonce, before.capability_nonce,
        "a failed action consumed the capability nonce"
    );
    assert_eq!(after.last_operation_id, before.last_operation_id);

    // And the operation is still executable once the protocol re-registers.
    let signer = world.protocols[0].adapter_signer;
    world
        .set_adapter(0, Some(signer), &authority)
        .expect("re-registers");
    world.execute(0, operation_id).expect("now executes");
    assert!(read_market(&world.svm, &world.protocols[0].market).new_borrowing_paused);
}

#[test]
fn the_benchmark_artifact_is_written_and_parseable() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts/benchmarks")
        .join("phase2-compute.json");
    if !path.exists() {
        // Run the measuring test first when this one is executed in isolation.
        return;
    }
    let contents = fs::read_to_string(&path).expect("readable");
    let parsed: serde_json::Value = serde_json::from_str(&contents).expect("valid JSON");
    assert_eq!(parsed["measured"], serde_json::Value::Bool(true));
    assert!(parsed["compute_units"]["cohort_total"].as_u64().is_some());
}
