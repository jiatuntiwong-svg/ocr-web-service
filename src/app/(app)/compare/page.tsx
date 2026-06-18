"use client";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import FeatureDisabled from "@/components/FeatureDisabled";
import { useApp } from "@/lib/contexts/AppContext";
import { useTranslation } from "@/lib/i18n/LocaleContext";

const CompareWorkspace = dynamic(() => import("@/components/CompareWorkspace"), { ssr: false });

export default function ComparePage() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, usageStats } = useApp();

    if (usageStats.features?.compare === false) {
        return <FeatureDisabled name={t("feature.compare")} onUpgrade={() => router.push("/billing")} />;
    }
    return <CompareWorkspace user={user} balance={usageStats.creditsRemaining} />;
}
