//! Canonical action bundles.
//!
//! Two shapes live here and the difference matters.
//!
//! An **action template** is what a protocol registers when it arms its adapter. It is
//! operation-independent: the target program, the discriminator, the instruction bytes,
//! the effect bound, and the account list with operation-derived slots left as roles
//! rather than addresses. A protocol authority reviews and signs this.
//!
//! A **canonical action** is the concrete instruction for one operation, with every
//! address resolved. Its hash is what the certificate binds and what the adapter checks.
//!
//! Account metas are never sorted. Solana instruction order is semantic, and reordering
//! two metas changes which account a program writes to. Every ordering helper in this
//! crate applies to sets (members, policies, adapters); none of them touches account
//! metas or action order.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, sha256, Digest32};
use crate::limits::{MAX_ACCOUNT_METAS, MAX_ACTIONS, MAX_INSTRUCTION_DATA};

/// The upper bound on what one adapter action may do.
///
/// Every category the hackathon authorises is a boolean state flip, so the bound is a
/// flag rather than an amount. Keeping it a struct means adding an amount-bounded
/// category later is a field addition and a `V2`, not a redesign.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectLimitV1 {
    /// The action may set the target's pause flag.
    pub may_pause: bool,
    /// The action may clear the target's pause flag.
    ///
    /// False for every hackathon capability. Unpausing is a protocol decision, not a
    /// circle decision, so an emergency covenant must never be able to resume borrowing.
    pub may_unpause: bool,
    /// Maximum value the action may move. Zero for every hackathon capability.
    pub max_value_moved: u64,
}

impl EffectLimitV1 {
    /// The only bound the hackathon covenant authorises: pause, never unpause, move nothing.
    pub const PAUSE_ONLY: EffectLimitV1 = EffectLimitV1 {
        may_pause: true,
        may_unpause: false,
        max_value_moved: 0,
    };
}

/// What an account slot in a template resolves to.
///
/// Receipt addresses depend on the operation ID, and the operation ID is drawn at
/// certification. A template therefore cannot name them. Declaring the role instead lets
/// the protocol authority pin the shape of the instruction at arm time while the adapter
/// re-derives the concrete address from the operation ID at execution time. The adapter
/// recomputing the PDA is stronger than trusting a hash of a supplied address.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountRoleV1 {
    /// A fixed address, known and pinned at arm time.
    Fixed,
    /// The adapter receipt PDA for this operation and this adapter.
    AdapterReceipt,
    /// The settlement receipt PDA for this operation.
    SettlementReceipt,
    /// The incident certificate account for this operation.
    Certificate,
}

/// One account slot in a registered template.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct TemplateAccountMetaV1 {
    /// How this slot's address is determined.
    pub role: AccountRoleV1,
    /// The address, when `role` is [`AccountRoleV1::Fixed`]. Zero otherwise.
    pub pubkey: Address,
    /// Whether the instruction requires this account to sign.
    pub is_signer: bool,
    /// Whether the instruction writes to this account.
    pub is_writable: bool,
}

impl TemplateAccountMetaV1 {
    /// A fixed slot.
    pub fn fixed(pubkey: Address, is_signer: bool, is_writable: bool) -> Self {
        Self {
            role: AccountRoleV1::Fixed,
            pubkey,
            is_signer,
            is_writable,
        }
    }

    /// An operation-derived slot.
    pub fn derived(role: AccountRoleV1, is_signer: bool, is_writable: bool) -> Self {
        Self {
            role,
            pubkey: Address::ZERO,
            is_signer,
            is_writable,
        }
    }

    /// Rejects a slot whose role and address disagree.
    ///
    /// A derived slot carrying a concrete address would let a caller pin an address the
    /// adapter is supposed to re-derive, which is exactly the substitution this design
    /// prevents.
    pub fn validate(&self) -> Result<(), VinctTypesError> {
        match self.role {
            AccountRoleV1::Fixed => {
                if self.pubkey.is_zero() {
                    return Err(VinctTypesError::TemplateRoleAddressMismatch);
                }
            }
            _ => {
                if !self.pubkey.is_zero() {
                    return Err(VinctTypesError::TemplateRoleAddressMismatch);
                }
            }
        }
        Ok(())
    }
}

/// A registered action template, reviewed and armed by one protocol authority.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionTemplateV1 {
    /// Domain separator for `VINCT_ACTION_TEMPLATE_V1`.
    pub domain: Digest32,
    /// Position in the covenant's registration order. Never reordered.
    pub action_index: u16,
    /// The adapter program that will execute this action.
    pub adapter_program_id: Address,
    /// The adapter version this template was armed against.
    pub adapter_version: u16,
    /// The capability account holding this protocol's bounds.
    pub adapter_capability: Address,
    /// The protocol program the adapter will call.
    pub target_program_id: Address,
    /// The exact instruction the adapter will invoke on the target.
    pub instruction_discriminator: [u8; 8],
    /// Account slots in exact instruction order. Never sorted.
    pub account_metas: Vec<TemplateAccountMetaV1>,
    /// The exact instruction bytes. Fixed at arm time.
    pub instruction_data: Vec<u8>,
    /// The upper bound on this action's effect.
    pub effect_limit: EffectLimitV1,
}

impl ActionTemplateV1 {
    /// Builds a template with its domain separator already set.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        action_index: u16,
        adapter_program_id: Address,
        adapter_version: u16,
        adapter_capability: Address,
        target_program_id: Address,
        instruction_discriminator: [u8; 8],
        account_metas: Vec<TemplateAccountMetaV1>,
        instruction_data: Vec<u8>,
        effect_limit: EffectLimitV1,
    ) -> Self {
        Self {
            domain: domain(domains::ACTION_TEMPLATE_V1),
            action_index,
            adapter_program_id,
            adapter_version,
            adapter_capability,
            target_program_id,
            instruction_discriminator,
            account_metas,
            instruction_data,
            effect_limit,
        }
    }

    /// Enforces every bound and slot rule on this template.
    pub fn validate(&self) -> Result<(), VinctTypesError> {
        if self.account_metas.is_empty() {
            return Err(VinctTypesError::EmptyAccountMetas);
        }
        if self.account_metas.len() > MAX_ACCOUNT_METAS {
            return Err(VinctTypesError::TooManyAccountMetas);
        }
        if self.instruction_data.len() > MAX_INSTRUCTION_DATA {
            return Err(VinctTypesError::InstructionDataTooLong);
        }
        for meta in &self.account_metas {
            meta.validate()?;
        }
        Ok(())
    }

    /// This template's digest.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }

    /// The ordered account-meta commitment an adapter capability stores.
    ///
    /// Separate from the whole-template hash because the adapter checks the meta list on
    /// its own, independently of the rest of the template.
    pub fn ordered_account_metas_hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(&self.account_metas)
    }

    /// The instruction-data commitment an adapter capability stores.
    pub fn instruction_data_hash(&self) -> Digest32 {
        sha256(&self.instruction_data)
    }
}

/// The registered bundle of templates for one policy, in covenant order.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionBundleTemplateV1 {
    /// Templates in covenant registration order. Never sorted.
    pub actions: Vec<ActionTemplateV1>,
}

impl ActionBundleTemplateV1 {
    /// Builds a bundle template from templates already in registration order.
    pub fn new(actions: Vec<ActionTemplateV1>) -> Result<Self, VinctTypesError> {
        let template = Self { actions };
        template.validate()?;
        Ok(template)
    }

    /// Enforces bundle-level bounds and index discipline.
    ///
    /// Indices must be the contiguous sequence `0..len` in that exact order. A gap, a
    /// repeat, or a permutation is rejected, so a bundle cannot silently drop or reorder
    /// an action while still looking well-formed.
    pub fn validate(&self) -> Result<(), VinctTypesError> {
        if self.actions.is_empty() {
            return Err(VinctTypesError::EmptyActionBundle);
        }
        if self.actions.len() > MAX_ACTIONS {
            return Err(VinctTypesError::TooManyActions);
        }
        validate_action_indices(self.actions.iter().map(|a| a.action_index))?;
        for action in &self.actions {
            action.validate()?;
        }
        Ok(())
    }

    /// The commitment a policy stores as `action_bundle_template_hash`.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        self.validate()?;
        hash_borsh(self)
    }
}

/// One concrete account meta, in exact Solana instruction order.
///
/// Mirrors PRD section 12.3.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanonicalAccountMetaV1 {
    /// The resolved account address.
    pub pubkey: Address,
    /// Whether the instruction requires this account to sign.
    pub is_signer: bool,
    /// Whether the instruction writes to this account.
    pub is_writable: bool,
}

/// One concrete action for one operation.
///
/// Mirrors PRD section 12.3.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CanonicalActionV1 {
    /// Position in covenant registration order.
    pub action_index: u16,
    /// The adapter program that executes this action.
    pub adapter_program_id: Address,
    /// The adapter version this action was built against.
    pub adapter_version: u16,
    /// The capability account holding the protocol's bounds.
    pub adapter_capability: Address,
    /// The protocol program the adapter calls.
    pub target_program_id: Address,
    /// The exact instruction invoked on the target.
    pub instruction_discriminator: [u8; 8],
    /// Account metas in exact instruction order. Never sorted.
    pub account_metas: Vec<CanonicalAccountMetaV1>,
    /// The exact instruction bytes.
    pub instruction_data: Vec<u8>,
    /// The upper bound on this action's effect.
    pub effect_limit: EffectLimitV1,
    /// The capability nonce this action consumes.
    pub capability_nonce: u64,
}

/// The concrete action bundle one certificate binds.
///
/// Mirrors PRD section 12.3, with one correction. The PRD's `operation_id` derivation
/// took the concrete bundle hash as an input while the bundle itself carried the
/// operation ID, which cannot be computed. See [`operation_id`] and
/// `docs/decision-log.md` entry D-0012.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionBundleV1 {
    /// Domain separator for `VINCT_ACTION_BUNDLE_V1`.
    pub domain: Digest32,
    /// Genesis hash of the cluster this bundle may execute on.
    pub cluster_genesis_hash: Digest32,
    /// The covenant this bundle belongs to.
    pub covenant: Address,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident this bundle settles.
    pub incident_id: u64,
    /// The policy that authorised it.
    pub policy_id: Digest32,
    /// The frozen member set.
    pub member_set_hash: Digest32,
    /// Slot after which this bundle may no longer be attempted.
    pub bundle_expiry_slot: u64,
    /// The operation this bundle executes under.
    pub operation_id: Digest32,
    /// Actions in covenant registration order. Never sorted.
    pub actions: Vec<CanonicalActionV1>,
}

impl ActionBundleV1 {
    /// Enforces bundle-level bounds and index discipline.
    pub fn validate(&self) -> Result<(), VinctTypesError> {
        if self.actions.is_empty() {
            return Err(VinctTypesError::EmptyActionBundle);
        }
        if self.actions.len() > MAX_ACTIONS {
            return Err(VinctTypesError::TooManyActions);
        }
        validate_action_indices(self.actions.iter().map(|a| a.action_index))?;
        for action in &self.actions {
            if action.account_metas.is_empty() {
                return Err(VinctTypesError::EmptyAccountMetas);
            }
            if action.account_metas.len() > MAX_ACCOUNT_METAS {
                return Err(VinctTypesError::TooManyAccountMetas);
            }
            if action.instruction_data.len() > MAX_INSTRUCTION_DATA {
                return Err(VinctTypesError::InstructionDataTooLong);
            }
            for meta in &action.account_metas {
                if meta.pubkey.is_zero() {
                    return Err(VinctTypesError::ZeroResolvedAddress);
                }
            }
        }
        Ok(())
    }

    /// The action-bundle hash the certificate binds and the adapter checks.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        self.validate()?;
        hash_borsh(self)
    }
}

/// Rejects any index sequence that is not exactly `0, 1, .. len-1`.
fn validate_action_indices(
    indices: impl Iterator<Item = u16> + Clone,
) -> Result<(), VinctTypesError> {
    let collected: Vec<u16> = indices.collect();
    let mut seen = collected.clone();
    seen.sort_unstable();
    for pair in seen.windows(2) {
        if pair[0] == pair[1] {
            return Err(VinctTypesError::DuplicateActionIndex);
        }
    }
    for (position, index) in collected.iter().enumerate() {
        let expected = u16::try_from(position).map_err(|_| VinctTypesError::TooManyActions)?;
        if *index != expected {
            return Err(VinctTypesError::ActionIndexNotSequential);
        }
    }
    Ok(())
}

/// Inputs to the operation ID.
///
/// Every field is known before the concrete bundle exists, which is what breaks the
/// PRD's circular derivation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OperationInputsV1 {
    /// Genesis hash of the cluster the operation may execute on.
    pub cluster_genesis_hash: Digest32,
    /// The covenant.
    pub covenant: Address,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// The policy that authorised the operation.
    pub policy_id: Digest32,
    /// The frozen member set.
    pub member_set_hash: Digest32,
    /// The policy's registered action template commitment.
    pub action_bundle_template_hash: Digest32,
    /// The nonce drawn once, at certification.
    pub certificate_nonce: u64,
}

/// The operation ID: the durable identity every effect is idempotent against.
///
/// PRD section 12.4 derived this from the concrete action-bundle hash, but PRD section
/// 12.3 puts the operation ID inside that same bundle, so neither can be computed first.
/// Receipt PDAs are seeded by the operation ID and appear in the bundle's account metas,
/// which closes the loop a second time.
///
/// This derivation takes the policy's registered *template* hash instead. The template is
/// operation-independent, so the cycle disappears while every binding the PRD's security
/// invariants require is kept: cluster, covenant, epoch, incident, policy, member set,
/// registered bundle shape, and nonce. Binding to the concrete per-incident bundle is not
/// lost either, because the certificate carries `action_bundle_hash` alongside the
/// operation ID and the adapter validates both.
pub fn operation_id(inputs: &OperationInputsV1) -> Digest32 {
    let mut preimage = Vec::with_capacity(32 * 6 + 8 * 3);
    preimage.extend_from_slice(&domain(domains::OPERATION_V1));
    preimage.extend_from_slice(&inputs.cluster_genesis_hash);
    preimage.extend_from_slice(inputs.covenant.as_bytes());
    preimage.extend_from_slice(&inputs.circle_epoch.to_le_bytes());
    preimage.extend_from_slice(&inputs.incident_id.to_le_bytes());
    preimage.extend_from_slice(&inputs.policy_id);
    preimage.extend_from_slice(&inputs.member_set_hash);
    preimage.extend_from_slice(&inputs.action_bundle_template_hash);
    preimage.extend_from_slice(&inputs.certificate_nonce.to_le_bytes());
    sha256(&preimage)
}

/// The concrete addresses a template's derived slots resolve to.
///
/// Supplied by the caller because deriving a program address needs an off-curve check
/// this crate deliberately does not depend on. On-chain code fills these with
/// `find_program_address`; the reference model and its vectors use deterministic
/// stand-ins. Either way the resolution is checked, never trusted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolvedAddressesV1 {
    /// Adapter receipt PDA per adapter program, in the order actions appear.
    pub adapter_receipts: Vec<Address>,
    /// Settlement receipt PDA for this operation.
    pub settlement_receipt: Option<Address>,
    /// Certificate account for this operation.
    pub certificate: Option<Address>,
}

/// Turns registered templates into the concrete bundle for one operation.
///
/// The caller supplies the operation ID and the addresses its derived slots resolve to.
/// Nothing is reordered: action order and account-meta order come straight from the
/// registered templates.
#[allow(clippy::too_many_arguments)]
pub fn resolve_bundle(
    template: &ActionBundleTemplateV1,
    cluster_genesis_hash: Digest32,
    covenant: Address,
    circle_epoch: u64,
    incident_id: u64,
    policy_id: Digest32,
    member_set_hash: Digest32,
    bundle_expiry_slot: u64,
    operation: Digest32,
    capability_nonces: &[u64],
    resolved: &ResolvedAddressesV1,
) -> Result<ActionBundleV1, VinctTypesError> {
    template.validate()?;
    if capability_nonces.len() != template.actions.len() {
        return Err(VinctTypesError::UnresolvedTemplateAddress);
    }

    let mut actions = Vec::with_capacity(template.actions.len());
    for (position, action_template) in template.actions.iter().enumerate() {
        let mut metas = Vec::with_capacity(action_template.account_metas.len());
        for meta in &action_template.account_metas {
            let pubkey = match meta.role {
                AccountRoleV1::Fixed => meta.pubkey,
                AccountRoleV1::AdapterReceipt => *resolved
                    .adapter_receipts
                    .get(position)
                    .ok_or(VinctTypesError::UnresolvedTemplateAddress)?,
                AccountRoleV1::SettlementReceipt => resolved
                    .settlement_receipt
                    .ok_or(VinctTypesError::UnresolvedTemplateAddress)?,
                AccountRoleV1::Certificate => resolved
                    .certificate
                    .ok_or(VinctTypesError::UnresolvedTemplateAddress)?,
            };
            if pubkey.is_zero() {
                return Err(VinctTypesError::ZeroResolvedAddress);
            }
            metas.push(CanonicalAccountMetaV1 {
                pubkey,
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            });
        }

        actions.push(CanonicalActionV1 {
            action_index: action_template.action_index,
            adapter_program_id: action_template.adapter_program_id,
            adapter_version: action_template.adapter_version,
            adapter_capability: action_template.adapter_capability,
            target_program_id: action_template.target_program_id,
            instruction_discriminator: action_template.instruction_discriminator,
            account_metas: metas,
            instruction_data: action_template.instruction_data.clone(),
            effect_limit: action_template.effect_limit,
            capability_nonce: capability_nonces[position],
        });
    }

    let bundle = ActionBundleV1 {
        domain: domain(domains::ACTION_BUNDLE_V1),
        cluster_genesis_hash,
        covenant,
        circle_epoch,
        incident_id,
        policy_id,
        member_set_hash,
        bundle_expiry_slot,
        operation_id: operation,
        actions,
    };
    bundle.validate()?;
    Ok(bundle)
}
