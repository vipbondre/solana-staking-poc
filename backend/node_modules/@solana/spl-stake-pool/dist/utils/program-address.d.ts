import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
/**
 * Generates the withdraw authority program address for the stake pool
 */
export declare function findWithdrawAuthorityProgramAddress(programId: PublicKey, stakePoolAddress: PublicKey): Promise<PublicKey>;
/**
 * Generates the stake program address for a validator's vote account
 */
export declare function findStakeProgramAddress(programId: PublicKey, voteAccountAddress: PublicKey, stakePoolAddress: PublicKey): Promise<PublicKey>;
/**
 * Generates the stake program address for a validator's vote account
 */
export declare function findTransientStakeProgramAddress(programId: PublicKey, voteAccountAddress: PublicKey, stakePoolAddress: PublicKey, seed: BN): Promise<PublicKey>;
