export interface ControlPlaneNotifier {
    send(text: string): Promise<void>;
}
export declare function createTelegramControlPlaneNotifier(jid: string): ControlPlaneNotifier | null;
//# sourceMappingURL=control-plane-notifier.d.ts.map