/**
 * ConnectWise — Conversion Pages Identification (Web Rollout) configuration
 *
 * The web rollout runs SITEWIDE and passes the page <title> into the hidden
 * field CWS_Cr02__c on every form that has it:
 *
 *   • Regular forms   → value is the page title exactly (e.g. "The State of SMB Cybersecurity…")
 *   • Footer forms    → value is "Footer: " + page title (e.g. "Footer: The State…")
 *
 * The title is passed without any query parameter (document.title carries no
 * query string by definition).
 *
 * These pages are the ones explicitly targeted by the rollout config
 * ("ConnectWise TF: Conversion Pages Identification").
 */

export const HIDDEN_FIELD = 'CWS_Cr02__c';

export const FOOTER_PREFIX = 'Footer: ';

/**
 * All pages targeted by the rollout, grouped by category.
 * Each entry has a unique `label` (used in test titles) and the live `url`.
 */
export const PAGES = [
  // ── Platform demo (runs FIRST — sanity check that CWS_Cr02__c is filled on
  //    both the regular form and the footer form before the full sweep) ──────
  { category: 'conversion', label: 'Platform Demo', url: 'https://www.connectwise.com/platform/demo' },

  // ── Resources / content download ──────────────────────────────────────────
  { category: 'resources', label: 'Resources: SLI Annual Profitability Report', url: 'https://www.connectwise.com/resources/sli-annual-profitability-report-exec-summary' },
  { category: 'resources', label: 'Resources: State of SMB Cybersecurity',       url: 'https://www.connectwise.com/resources/state-of-smb-cybersecurity' },
  { category: 'resources', label: 'Resources: Ultimate Guide to Ending Tool Sprawl', url: 'https://www.connectwise.com/resources/the-ultimate-guide-to-ending-tool-sprawl' },

  // ── Conversion / demo ─────────────────────────────────────────────────────
  { category: 'conversion', label: 'RMM Packages (pricing)',   url: 'https://www.connectwise.com/rmm-packages' },
  { category: 'conversion', label: 'Business Management Demo', url: 'https://www.connectwise.com/solutions/business-management/demo' },

  // ── Webinars ──────────────────────────────────────────────────────────────
  { category: 'webinars', label: 'Webinar: Building a Predictable Service Desk',           url: 'https://www.connectwise.com/webinars/building-a-predictable-service-desk' },
  { category: 'webinars', label: 'Webinar: Configure Share and Demonstrate Value',         url: 'https://www.connectwise.com/webinars/configure-share-and-demonstrate-value' },
  { category: 'webinars', label: 'Webinar: ConnectWise PSA End User Portal',               url: 'https://www.connectwise.com/webinars/connectwise-psa-end-user-portal' },
  { category: 'webinars', label: 'Webinar: PSA Essentials — Streamlined Service Desk',     url: 'https://www.connectwise.com/webinars/connectwise-psa-essentials-building-a-streamlined-service-desk' },
  { category: 'webinars', label: 'Webinar: ConnectWise PSA Time Flies',                    url: 'https://www.connectwise.com/webinars/connectwise-psa-time-flies' },
  { category: 'webinars', label: 'Webinar: RMM Alerts Customization',                      url: 'https://www.connectwise.com/webinars/connectwise-rmm-alerts-customization-and-functionality' },
  { category: 'webinars', label: 'Webinar: RMM Setting Up Network Monitoring',             url: 'https://www.connectwise.com/webinars/connectwise-rmm-setting-up-network-monitoring' },
  { category: 'webinars', label: 'Webinar: Dashboards, SLAs & Automation in PSA',          url: 'https://www.connectwise.com/webinars/dashboards-slas-and-automation-in-connectwise-psa' },
  { category: 'webinars', label: 'Webinar: Executive Town Hall — Reactive to Predictive',  url: 'https://www.connectwise.com/webinars/executive-town-hall-from-reactive-to-predictive-it' },
  { category: 'webinars', label: 'Webinar: Trusted Remote Access to Proactive Endpoint Mgmt', url: 'https://www.connectwise.com/webinars/from-trusted-remote-access-to-proactive-endpoint-management' },
  { category: 'webinars', label: 'Webinar: Get Up to Speed — Elovade Nordics',             url: 'https://www.connectwise.com/webinars/get-up-to-speed-elovade-nordics' },
  { category: 'webinars', label: 'Webinar: How MSPs Get Started with Agentic AI',          url: 'https://www.connectwise.com/webinars/how-msps-get-started-with-agentic-ai' },
  { category: 'webinars', label: 'Webinar: Important IT Nation Updates for Vendors',       url: 'https://www.connectwise.com/webinars/important-it-nation-event-updates-for-vendors' },
  { category: 'webinars', label: 'Webinar: Mastering Alert Management',                    url: 'https://www.connectwise.com/webinars/mastering-alert-management' },
  { category: 'webinars', label: 'Webinar: MPI, BMS & UMM',                                url: 'https://www.connectwise.com/webinars/mpi-bms-and-umm' },
  { category: 'webinars', label: 'Webinar: MPI, BMS & UMM (April)',                        url: 'https://www.connectwise.com/webinars/mpi-bms-and-umm/april' },
  { category: 'webinars', label: 'Webinar: MPI, BMS & UMM (July)',                         url: 'https://www.connectwise.com/webinars/mpi-bms-and-umm/july' },
  { category: 'webinars', label: 'Webinar: MPI Cybersecurity & Data Protection',           url: 'https://www.connectwise.com/webinars/mpi-cybersecurity-and-data-protection' },
  { category: 'webinars', label: 'Webinar: Platform Instance Region Migration',            url: 'https://www.connectwise.com/webinars/platform-instance-region-migration' },
  { category: 'webinars', label: 'Webinar: Platform-Native Agentic AI vs Generic LLMs',    url: 'https://www.connectwise.com/webinars/platform-native-agentic-ai-vs-generic-llms' },
  { category: 'webinars', label: 'Webinar: PSA Procurement',                               url: 'https://www.connectwise.com/webinars/psa-procurement' },
  { category: 'webinars', label: 'Webinar: Quoting in CPQ',                                url: 'https://www.connectwise.com/webinars/quoting-in-cpq' },
  { category: 'webinars', label: 'Webinar: Ready Your PSA for AI',                         url: 'https://www.connectwise.com/webinars/ready-your-psa-for-ai' },
  { category: 'webinars', label: 'Webinar: Service Desk Features that Boost Efficiency',   url: 'https://www.connectwise.com/webinars/service-desk-features-that-boost-efficiency' },
  { category: 'webinars', label: 'Webinar: Service Desk on the Platform',                  url: 'https://www.connectwise.com/webinars/service-desk-on-the-platform' },
  { category: 'webinars', label: 'Webinar: SLI Data',                                      url: 'https://www.connectwise.com/webinars/sli-data' },
  { category: 'webinars', label: 'Webinar: Smarter Sales Tax with ConnectWise & Avalara',  url: 'https://www.connectwise.com/webinars/smarter-sales-tax-with-connectwise-and-avatax' },
  { category: 'webinars', label: 'Webinar: Stop Losing Service Desk Capacity (Part 2)',    url: 'https://www.connectwise.com/webinars/stop-losing-service-desk-capacity-part-2' },
  { category: 'webinars', label: 'Webinar: Tracking Your Projects with BrightGauge',       url: 'https://www.connectwise.com/webinars/tracking-your-projects-with-brightgauge' },
  { category: 'webinars', label: 'Webinar: What is an AI Agent?',                          url: 'https://www.connectwise.com/webinars/what-is-an-ai-agent' },
  { category: 'webinars', label: 'Webinar: When Monitoring is Not Enough',                 url: 'https://www.connectwise.com/webinars/when-monitoring-is-not-enough' },

  // ── Home / blog ───────────────────────────────────────────────────────────
  { category: 'blog', label: 'Home',                                             url: 'https://www.connectwise.com/' },
  { category: 'blog', label: 'Blog',                                             url: 'https://www.connectwise.com/blog' },
  { category: 'blog', label: 'Blog: AI ConnectWise PSA',                         url: 'https://www.connectwise.com/blog/ai-connectwise-psa' },
  { category: 'blog', label: 'Blog: Technology Around Outcomes MSPs Need',       url: 'https://www.connectwise.com/blog/building-technology-around-the-outcomes-msps-and-it-teams-need' },
  { category: 'blog', label: 'Blog: Cloud Data Protection Strategy',             url: 'https://www.connectwise.com/blog/cloud-data-protection-strategy' },
  { category: 'blog', label: 'Blog: Common Threats and Attacks',                 url: 'https://www.connectwise.com/blog/common-threats-and-attacks' },
  { category: 'blog', label: 'Blog: CPQ Integration',                             url: 'https://www.connectwise.com/blog/cpq-integration' },
];