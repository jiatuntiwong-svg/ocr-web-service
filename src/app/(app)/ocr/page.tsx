"use client";
import { useRouter } from "next/navigation";
import OCRWorkspace from "@/components/OCRWorkspace";
import OCRWorkspaceV2 from "@/components/OCRWorkspaceV2";
import FeatureDisabled from "@/components/FeatureDisabled";
import { useApp } from "@/lib/contexts/AppContext";
import { useTranslation } from "@/lib/i18n/LocaleContext";
import { ENABLE_OCR_WORKSPACE_V2 } from "@/lib/featureFlags";

export default function OcrPage() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, usageStats, fetchStats } = useApp();

    if (usageStats.features?.ocr === false) {
        return <FeatureDisabled name={t("feature.ocr")} onUpgrade={() => router.push("/billing")} />;
    }
    // UI-4b: route to v3 workspace when the flag is on. Default OFF in prod;
    // v3 is a placeholder scaffold today (see OCRWorkspaceV2.tsx).
    if (ENABLE_OCR_WORKSPACE_V2) {
        return (
            <OCRWorkspaceV2
                user={user}
                balance={usageStats.creditsRemaining}
                onDocumentProcessed={fetchStats}
                onNavigateToBilling={() => router.push("/billing")}
            />
        );
    }
    return (
        <OCRWorkspace
            user={user}
            balance={usageStats.creditsRemaining}
            onDocumentProcessed={fetchStats}
            onNavigateToBilling={() => router.push("/billing")}
        />
    );
}
