import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { AccountInfo, MintInfo } from '@solana/spl-token';
export declare function getTokenMint(connection: Connection, tokenMintPubkey: PublicKey): Promise<MintInfo | undefined>;
/**
 * Retrieve the associated account or create one if not found.
 * This account may then be used as a `transfer()` or `approve()` destination
 */
export declare function addAssociatedTokenAccount(connection: Connection, owner: PublicKey, mint: PublicKey, instructions: TransactionInstruction[]): Promise<{
    associatedAddress: PublicKey;
    rentFee: number;
}>;
export declare function getTokenAccount(connection: Connection, tokenAccountAddress: PublicKey, expectedTokenMint: PublicKey): Promise<AccountInfo | void>;
