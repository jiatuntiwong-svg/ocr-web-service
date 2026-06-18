"use client";
import { useRouter } from "next/navigation";
import OCRWorkspace from "@/components/OCRWorkspace";
import FeatureDisabled from "@/components/FeatureDisabled";
import { useApp } from "@/lib/contexts/AppContext";
import { useTranslation } from "@/lib/i18n/LocaleContext";

export default function OcrPage() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, usageStats, fetchStats } = useApp();

    if (usageStats.features?.ocr === false) {
        return <FeatureDisabled name={t("feature.ocr")} onUpgrade={() => router.push("/billing")} />;
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
