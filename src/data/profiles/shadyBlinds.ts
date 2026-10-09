import type { CustomerProfile } from "../schema";

/* Deterministic daily series for the Quality Management dashboards — one point
   per day of the canonical month (01/01…01/31), so a chart never covers a
   different window than the date filter above it.

   Each series is re-centred on the mean it was asked for, and a count/revenue
   series can additionally be pinned to an exact monthly TOTAL. That's what lets
   a tile say "average 71%" or "$37,800,000 total" and have it be literally true
   of the bars underneath — the old version drifted ~2 points high because its
   `(i % 5)` sawtooth wasn't zero-mean. */
const QM_DAYS = 31;
function qmDays(
  barMean: number, barAmp: number, lineMean: number, lineAmp: number,
  withLine: boolean, lineTotal?: number,
) {
  const build = (mean: number, amp: number, phase: number, total?: number) => {
    const raw = Array.from({ length: QM_DAYS }, (_, i) =>
      mean + amp * Math.sin(i * 0.8 + phase) + amp * 0.28 * Math.sin(i * 2.3 + phase));
    const shift = mean - raw.reduce((s, v) => s + v, 0) / QM_DAYS;
    const out = raw.map((v) => Math.max(0, Math.round(v + shift)));
    const target = Math.round(total ?? mean * QM_DAYS);
    out[QM_DAYS - 1] += target - out.reduce((s, v) => s + v, 0);
    return out;
  };
  const bars = build(barMean, barAmp, 0);
  const lines = withLine ? build(lineMean, lineAmp, 1.2, lineTotal) : null;
  return Array.from({ length: QM_DAYS }, (_, i) => {
    const label = `01/${String(i + 1).padStart(2, "0")}`;
    const p: { label: string; bar: number; line?: number } = { label, bar: bars[i] };
    if (lines) p.line = lines[i];
    return p;
  });
}

/* Reference profile — real data captured from the live Invoca demo network. */
export const shadyBlinds: CustomerProfile = {
  id: "shady-blinds",
  customerName: "Shady Blinds",
  websiteUrl: "https://www.shadyblindsnow.com/",
  brandDomain: "shadyblindsnow.com",
  networkName: "Invoca for Home Services",
  industry: "Window treatments & home services",
  bookingTerm: "Consultation",
  customerNoun: "Customer",
  reports: {
    digitalInsights: {
      title: "Digital Journey & Call Attribution Report",
      dateRange: "Jan 1, 2026, Jan 31, 2026",
      filterLabel: "Marketing Source: 3 selected",
      chartLegend: "Total Interactions",
      yMax: 16000,
      yTicks: [0, 4000, 8000, 12000, 16000],
      chart: [
        { date: "Jan 1-4", value: 7679 },
        { date: "Jan 5-11", value: 13992 },
        { date: "Jan 12-18", value: 14269 },
        { date: "Jan 19-25", value: 13853 },
        { date: "Jan 26-31", value: 11754 },
      ],
      dimensionColumns: [
        "Marketing Source","Marketing Medium","Marketing Campaign",
        "Marketing Search Term","Full Landing Page URL","Website Journey",
      ],
      signalColumns: [
        { label: "Answered by Agent", badges: ["Rule"] },
        { label: "Consultation Discussed (Industry)", badges: ["Keyword Spotting","Rule"] },
        { label: "Consultation Booked (Conversion)", badges: ["Keyword Spotting","Rule"] },
      ],
      rows: [
        { marketingSource:"Social Media", marketingMedium:"Instagram", marketingCampaign:"We Come to You", marketingSearchTerm:"—", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=instagram&utm_medium=social&utm_campaign=WeComeToYou", websiteJourney:"Home / Shades / Roman Shades", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"The Privacy Project", marketingSearchTerm:"traditional colonial window shutters", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Privacy", websiteJourney:"Home / Shutters / Traditional Shutters", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Design Before You Decide", marketingSearchTerm:"plantation shutters for living room windows", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Design", websiteJourney:"Home / Shutters / Plantation Shutters", signals:[true,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"First Look Free", marketingSearchTerm:"fabric blinds for living room light control", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=FirstLook", websiteJourney:"Home / Blinds / Fabric Blinds", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"bamboo woven wood shades natural look", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Shades / Bamboo Shades", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"faux wood blinds moisture resistant bathroom", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Blinds / Faux Wood Blinds", signals:[true,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"The Privacy Project", marketingSearchTerm:"pleated shades for small windows", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Privacy", websiteJourney:"Home / Shades / Pleated Shades", signals:[true,true,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"roller shades for bedroom blackout", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Shades / Roller Shades", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"Bing", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"blackout curtains for bedroom sleep", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=bing&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Drapes / Blackout Drapes", signals:[true,false,false] },
        { marketingSource:"Organic", marketingMedium:"Organic", marketingCampaign:"—", marketingSearchTerm:"—", landingPageUrl:"https://ShadyBlindsNow.com/", websiteJourney:"Home / Shutters / Faux Wood Shutters", signals:[true,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Block It Out", marketingSearchTerm:"free window treatment consultation near me", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=BlockItOut", websiteJourney:"Home / Services / Free In-Home Consultation", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"Bing", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"cellular shades for energy savings", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=bing&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Shades / Cellular Shades", signals:[true,true,true] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Design Before You Decide", marketingSearchTerm:"professional blind installation service", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Design", websiteJourney:"Home / Services / Professional Installation", signals:[true,false,false] },
        { marketingSource:"Social Media", marketingMedium:"Facebook", marketingCampaign:"We Come to You", marketingSearchTerm:"—", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=facebook&utm_medium=social&utm_campaign=WeComeToYou", websiteJourney:"Home / Shutters / Composite Shutters", signals:[false,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"The Privacy Project", marketingSearchTerm:"vertical blinds for sliding glass door", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Privacy", websiteJourney:"Home / Blinds / Vertical Blinds", signals:[false,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Design Before You Decide", marketingSearchTerm:"motorized blinds smart home compatible", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Design", websiteJourney:"Home / Blinds / Motorized Blinds", signals:[false,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Block It Out", marketingSearchTerm:"bypass shutters for closet doors", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=BlockItOut", websiteJourney:"Home / Shutters / By-Pass Shutters", signals:[false,false,false] },
        { marketingSource:"Paid Search", marketingMedium:"cpc", marketingCampaign:"Summer Shade Event", marketingSearchTerm:"solar shades for patio doors", landingPageUrl:"https://ShadyBlindsNow.com/?utm_source=google&utm_medium=cpc&utm_campaign=Summer", websiteJourney:"Home / Shades / Solar Shades", signals:[false,false,false] },
      ],
    },
    marketingDashboard: {
      title: "Marketing Performance Dashboard (Shady Blinds)",
      dateRange: "1/1/2026-1/31/2026",
      kpiGroups: [
        { title: "Call Performance Summary", tiles: [
          { label: "Call Count", value: "48,293" },
          { label: "Sales Call (Percent)", value: "84%" },
          { label: "Purchase (Percent)", value: "25%" },
          { label: "Total Revenue (Sale Amount)", value: "$37,984,120" },
        ]},
        { title: "Non-Sales Inquiries", tiles: [
          { label: "Call Count", value: "7,727" },
          { label: "Support Call (Percent)", value: "8%" },
          { label: "Billing Call (Percent)", value: "5%" },
          { label: "Warranty Call (Percent)", value: "3%" },
        ]},
        { title: "Sales Call Breakout Metrics", tiles: [
          { label: "Sales Call (Percent)", value: "84%" },
          { label: "Quote Discussed (Percent)", value: "58%" },
          { label: "Unqualified Lead (Percent)", value: "26%" },
          { label: "Purchase (Percent)", value: "25%" },
        ]},
      ],
      breakdowns: [
        { title: "Calls by Source", tableTitle: "Source: Call Outcome Summary", dimensionColumn: "Marketing Source", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"Paid Search", metrics:["21,732","51%","16%","$9,775,181"] },
            { name:"Social Media", metrics:["9,659","54%","19%","$4,845,612"] },
            { name:"Organic", metrics:["7,244","64%","33%","$7,725,871"] },
            { name:"Print", metrics:["5,433","59%","26%","$3,786,945"] },
            { name:"Email", metrics:["4,225","93%","71%","$11,850,511"] },
          ]},
        { title: "Calls by Medium", tableTitle: "Medium: Call Outcome Summary", dimensionColumn: "Marketing Medium", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"cpc", metrics:["15,691","49%","13%","$5,865,109"] },
            { name:"Organic", metrics:["7,244","64%","33%","$7,725,871"] },
            { name:"Bing", metrics:["6,041","56%","23%","$3,910,072"] },
            { name:"Brochure", metrics:["5,433","59%","26%","$3,786,945"] },
            { name:"Facebook", metrics:["5,332","52%","18%","$2,471,262"] },
            { name:"Instagram", metrics:["4,327","55%","21%","$2,374,350"] },
            { name:"SFMC", metrics:["4,225","93%","71%","$11,850,511"] },
          ]},
        { title: "Calls by Campaign", tableTitle: "Campaign: Call Outcome Summary", dimensionColumn: "Marketing Campaign", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"Summer Shade Event", metrics:["11,378","50%","14%","$4,191,070"] },
            { name:"The Privacy Project", metrics:["7,186","55%","21%","$4,114,325"] },
            { name:"Design Before You Decide", metrics:["5,389","59%","27%","$4,190,641"] },
            { name:"Block It Out", metrics:["3,593","68%","38%","$4,292,190"] },
            { name:"Built for Business", metrics:["2,395","90%","67%","$6,761,928"] },
          ]},
        { title: "Calls by Search Term", tableTitle: "Search Term: Call Outcome Summary", dimensionColumn: "Marketing Search Term", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"blinds near me", metrics:["6,568","48%","12%","$1,772,081"] },
            { name:"window blinds cost", metrics:["3,941","52%","17%","$1,612,397"] },
            { name:"plantation shutters for living room", metrics:["2,791","63%","31%","$2,601,395"] },
            { name:"motorized blinds smart home", metrics:["1,970","74%","46%","$3,291,489"] },
            { name:"commercial window treatments quote", metrics:["1,149","97%","77%","$3,637,238"] },
          ]},
        { title: "Conversions by Product Category", tableTitle: "Conversions by Product Category", dimensionColumn: "Product Category", hasDonut: false,
          metricColumns: ["Call Count","Consultation Scheduled (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"Blinds", metrics:["16,420","40%","17%","$7,019,262"] },
            { name:"Shades", metrics:["12,556","43%","22%","$7,864,270"] },
            { name:"Shutters", metrics:["10,142","46%","28%","$11,031,852"] },
            { name:"Drapes", metrics:["5,795","49%","32%","$5,657,061"] },
            { name:"Services", metrics:["3,380","63%","56%","$6,411,675"] },
          ]},
        { title: "Calls by Line of Business", tableTitle: "Line of Business: Summary", dimensionColumn: "Line Of Business", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"Residential", metrics:["39,455","55%","21%","$22,398,732"] },
            { name:"Commercial", metrics:["8,838","72%","44%","$15,585,388"] },
          ]},
        { title: "Calls by Region", tableTitle: "Region Summary", dimensionColumn: "Location Region", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"South", metrics:["14,488","53%","19%","$7,807,989"] },
            { name:"Midwest", metrics:["11,590","56%","22%","$7,306,044"] },
            { name:"West", metrics:["10,142","58%","25%","$8,085,469"] },
            { name:"Northeast", metrics:["7,727","60%","27%","$7,079,911"] },
            { name:"Great Lakes", metrics:["4,346","77%","50%","$7,704,707"] },
          ]},
        { title: "Call by Division", tableTitle: "Division Summary", dimensionColumn: "Location Division", hasDonut: true,
          metricColumns: ["Call Count","Quote Discussed (Percent)","Purchase (Percent)","Total Revenue (Sale Amount)"],
          rows: [
            { name:"South Atlantic", metrics:["10,972","52%","17%","$5,103,038"] },
            { name:"Pacific", metrics:["8,229","55%","21%","$5,498,963"] },
            { name:"East North Central", metrics:["6,515","58%","25%","$4,616,273"] },
            { name:"Middle Atlantic", metrics:["5,143","61%","29%","$4,869,177"] },
            { name:"West South Central", metrics:["3,429","80%","54%","$6,881,274"] },
          ]},
      ],
      salesCallBreakoutGraph: {
        yLabel: "Sales Call (Count)",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Sales Call (Count)", values: [4802,8860,9316,9682,7906] },
          { name: "Quote Discussed (Count)", values: [3231,6031,6471,6785,5492] },
          { name: "Unqualified Lead (Count)", values: [1726,2907,2821,2707,2395] },
          { name: "Purchase (Count)", values: [1356,2563,2805,2967,2382] },
        ],
      },
      productCategoryGraph: {
        yLabel: "Purchase (Count)",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Blinds", values: [333,614,646,671,547] },
          { name: "Shades", values: [321,593,624,648,529] },
          { name: "Shutters", values: [335,619,650,676,552] },
          { name: "Drapes", values: [216,399,420,436,356] },
          { name: "Services", values: [223,412,434,451,368] },
        ],
      },
    },
    callReview: {
      shownCount: "15 Calls",
      totalNote: "total of 48,293 calls from Jan 1 to Jan 31",
      scoreDisplay: "Quality Score",
      sortBy: "Highest Score",
      dateRange: "01/01/2026-01/31/2026",
      calls: [
        { scoreLabel:"Quality Score", score:91, summary:"A caller named Karen Bishop called to schedule a free in-home consultation for plantation shutters in her living room. The agent confirmed her address, reviewed available appointment windows, and booked a design consultant for the following Tuesday at 10 AM. Karen asked about financing and the agent explained the 12-month no-interest plan. She thanked the agent and confirmed the appointment.", converted:true, date:"Jan 6, 10:12 AM", agent:"Oscar", duration:"1m 30s", scorecards:1, comments:0, negativeSentiment:0, evaluated:true },
        { scoreLabel:"Quality Score", score:84, summary:"A caller named David Nguyen followed up on a quote for motorized roller shades across five windows. The agent pulled up his estimate, walked through the pricing and the remote-control upgrade, and applied the current 15% summer promotion. David decided to move forward and scheduled a measurement appointment for that Thursday.", converted:true, date:"Jan 8, 2:41 PM", agent:"Lila", duration:"2m 04s", scorecards:1, comments:0, negativeSentiment:0, evaluated:false },
        { scoreLabel:"Quality Score", score:79, summary:"A caller named Maria Alvarez asked about the difference between faux wood and real wood blinds for a bathroom. The agent explained moisture resistance, recommended faux wood, provided pricing, and offered to email samples. Maria appreciated the guidance and requested the samples be sent to her.", converted:false, date:"Jan 9, 11:03 AM", agent:"Rosey", duration:"1m 47s", scorecards:1, comments:0, negativeSentiment:0, evaluated:false },
        { scoreLabel:"Quality Score", score:78, summary:"A caller named Jessica Harper contacted Shady Blinds to schedule an in-home consultation for new window treatments after a recent move. The agent collected her name, the rooms and windows involved, her product preference, and timeline, confirmed her service ZIP and a callback number, and booked a design consultant for the following week. Jessica was a new customer and confirmed the appointment.", converted:true, date:"Jan 12, 2:28 PM", agent:"Marcus Bell", duration:"2m 26s", scorecards:1, comments:1, negativeSentiment:1, evaluated:true },
        { scoreLabel:"Quality Score", score:68, summary:"A caller named Priya Shah requested a re-measure after her bay window shutters didn't fit correctly. The agent apologized, scheduled a technician for a complimentary re-measure, and flagged the file for the workroom. Priya was reassured the correction would be handled at no cost.", converted:false, date:"Jan 13, 9:35 AM", agent:"Lee", duration:"2m 11s", scorecards:1, comments:0, negativeSentiment:2, evaluated:false },
        { scoreLabel:"Quality Score", score:64, summary:"A caller named Greg Olsen wanted to add blackout drapes to an existing order. The agent confirmed the fabric was still available, added the item, and adjusted the delivery timeline. Greg approved the updated total and asked for an emailed confirmation.", converted:false, date:"Jan 14, 4:22 PM", agent:"Mike", duration:"1m 27s", scorecards:1, comments:0, negativeSentiment:1, evaluated:false },
        { scoreLabel:"Quality Score", score:60, summary:"A caller named Angela Ruiz called about a lift cord that stopped working on her roman shades installed last year. The agent walked her through a quick fix, and when that didn't resolve it, scheduled a warranty repair visit at no charge. Angela remained slightly frustrated but accepted the appointment.", converted:false, date:"Jan 15, 1:07 PM", agent:"Mary", duration:"2m 33s", scorecards:1, comments:0, negativeSentiment:3, evaluated:false },
        { scoreLabel:"Quality Score", score:57, summary:"A caller named Brian Foster was frustrated that his installation appointment was missed by the technician. The agent apologized, confirmed a scheduling error, expedited a new appointment for the next morning, and applied a service credit. Brian appreciated the resolution but noted the inconvenience.", converted:false, date:"Jan 16, 8:54 AM", agent:"Sue", duration:"2m 48s", scorecards:1, comments:1, negativeSentiment:4, evaluated:true },
        { scoreLabel:"Quality Score", score:49, summary:"A caller named Sofia Marin called upset that her delivered shutters arrived with a scratched panel. The agent apologized, arranged a replacement panel under warranty, and scheduled reinstallation. Sofia accepted the fix but expressed disappointment with the quality control.", converted:false, date:"Jan 20, 10:48 AM", agent:"Jennifer", duration:"2m 15s", scorecards:1, comments:0, negativeSentiment:3, evaluated:false },
        { scoreLabel:"Quality Score", score:47, summary:"A caller named Derek Palmer disputed a measurement fee on his invoice. The agent reviewed the charges, explained the fee is waived when an order is placed, and removed it. Derek was satisfied it was resolved but felt the policy should have been clearer up front.", converted:false, date:"Jan 21, 5:31 PM", agent:"Rose", duration:"1m 31s", scorecards:1, comments:0, negativeSentiment:5, evaluated:false },
        { scoreLabel:"Quality Score", score:44, summary:"A caller named Hannah Lee called about a long wait for her custom drapery order and unclear communication. The agent apologized for the delay, provided a firm ship date, and offered a discount on a future purchase. Hannah remained frustrated about the overall timeline.", converted:false, date:"Jan 22, 12:19 PM", agent:"Lee", duration:"2m 02s", scorecards:1, comments:0, negativeSentiment:5, evaluated:false },
        { scoreLabel:"Quality Score", score:41, summary:"A caller named Marcus Webb complained that the motorized blinds he purchased stopped responding to the remote. The agent troubleshot the batteries and pairing, then escalated to a technician visit. Marcus was irritated that the issue had recurred since installation.", converted:false, date:"Jan 23, 9:02 AM", agent:"Lee", duration:"2m 41s", scorecards:1, comments:0, negativeSentiment:6, evaluated:false },
        { scoreLabel:"Quality Score", score:38, summary:"A caller named Olivia Grant wanted to cancel her order after finding a competitor's lower price. The agent reviewed the order, was unable to fully match the price, and processed the cancellation per policy. Olivia was dissatisfied that the price could not be matched.", converted:false, date:"Jan 26, 4:47 PM", agent:"Jennifer", duration:"1m 58s", scorecards:1, comments:1, negativeSentiment:6, evaluated:false },
        { scoreLabel:"Quality Score", score:34, summary:"A caller named Ethan Brooks called angry about being billed twice for a single installation. The agent verified the duplicate charge, issued a refund, and apologized for the billing error. Ethan remained upset about the mistake despite the refund being processed.", converted:false, date:"Jan 27, 11:38 AM", agent:"Sue", duration:"2m 26s", scorecards:1, comments:0, negativeSentiment:6, evaluated:false },
        { scoreLabel:"Quality Score", score:0, summary:"A caller inquired about vertical blinds for a sliding glass door, but the call was not answered by an agent and rolled to voicemail. The caller left a message requesting a callback with pricing and lead times for a standard patio door.", converted:false, date:"Jan 19, 3:16 PM", agent:"No Agent", duration:"0m 41s", scorecards:0, comments:0, negativeSentiment:0, evaluated:false },
      ],
      searchSuggestions: ["shutters", "motorized", "warranty", "installation", "financing", "cancel"],
    },

    callDetail: {
      callId: "0597-627F62F2570D",
      agent: "Marcus Bell",
      date: "Jan 12, 2:28 PM",
      duration: "2m 26s",
      scorecardName: "BASE SKILLS",
      scorecardPercent: 78,
      scorecardPoints: "70/90 Points",
      scorecardRows: [
        { name: "(QA) Proper Greeting",      points: "10/10", status: "met" },
        { name: "(QA) Proper Close",         points: "0/10",  status: "unmet" },
        { name: "Capture Full Name",         points: "10/10", status: "met" },
        { name: "Capture Rooms & Windows",   points: "10/10", status: "met" },
        { name: "Capture Measurements",      points: "10/10", status: "met" },
        { name: "Capture Product Interest",  points: "10/10", status: "met" },
        { name: "Capture Timeline",          points: "10/10", status: "met" },
        { name: "Capture Email",             points: "0/10",  status: "unmet" },
        { name: "Capture Service ZIP",       points: "10/10", status: "met" },
        { name: "Offer Financing",           points: "—/—",   status: "na" },
      ],
      signalsMet: 13,
      signalsUnmet: 10,
      signalsNa: 7,
      metSignals: [
        "(QA) Proper Greeting", "Caller Type: New Customer", "Consultation: Scheduled",
        "Product Interest: Wood Blinds", "Rooms Captured", "Measurements Captured",
        "Timeline Captured", "Service Area Confirmed", "Full Name Captured",
        "Callback Number Captured", "Qualified Lead", "Appointment Offered", "Polite Tone",
      ],
      unmetSignals: [
        "(QA) Proper Close", "Email Captured", "Financing Offered", "Promotion Mentioned",
        "Empathy Statement", "Set Expectations for Visit", "Warranty Mentioned",
        "Referral Requested", "Follow-up Scheduled", "Upsell Offered",
      ],
      naSignals: [
        "Existing Order Located", "Delivery Status Given", "Billing Issue Resolved",
        "Repair Scheduled", "Return Processed", "Cancellation Handled", "Escalation Required",
      ],
      prompts: [
        { question: "Is the customer trying to solve a specific problem?", answer: "Yes, the caller recently moved and needs window treatments for a living room and two bedrooms, and wants to book an in-home consultation to see options." },
        { question: "What are the customer's expectations?", answer: "A timely consultation (within a few weeks), guidance on styles (she's leaning toward wood blinds), and confirmation that Shady Blinds services her area." },
        { question: "How could the agent handle the call better?", answer: "Strengthen empathy when the caller mentions the stress of a recent move, capture the email address (it was missed), and briefly outline what the in-home consultation includes so she knows what to expect." },
      ],
      convStart: "00:00",
      transcript: [
        { speaker: "agent",  time: "00:00", text: "Thank you for calling Shady Blinds. How can I assist you today?" },
        { speaker: "caller", time: "00:04", text: "Hi, I'm hoping to schedule a consultation for some new window treatments. I just moved into a new place and need blinds for a few rooms." },
        { speaker: "agent",  time: "00:14", text: "Certainly, I can help with that. May I start by getting your first and last name, please?" },
        { speaker: "caller", time: "00:19", text: "Sure, it's Jessica Harper." },
        { speaker: "agent",  time: "00:21", text: "Thank you, Jessica. Which rooms are you looking to cover?" },
        { speaker: "caller", time: "00:25", text: "The living room and two bedrooms." },
        { speaker: "agent",  time: "00:28", text: "Great. Do you know roughly how many windows that is, and their approximate sizes?" },
        { speaker: "caller", time: "00:35", text: "About six windows total, most around 36 by 48 inches." },
        { speaker: "agent",  time: "00:43", text: "Perfect. Do you have a style in mind, roller shades, wood blinds, cellular shades, or something else?" },
        { speaker: "caller", time: "00:49", text: "I'm leaning toward wood blinds, but I'd love to see the options." },
        { speaker: "agent",  time: "00:53", text: "Sounds good. How soon are you hoping to have them installed?" },
        { speaker: "caller", time: "01:02", text: "Ideally within the next few weeks." },
        { speaker: "agent",  time: "01:09", text: "Got it. What's the ZIP code for the installation address, so I can confirm we service your area?" },
        { speaker: "caller", time: "01:21", text: "It's 93101." },
        { speaker: "agent",  time: "01:27", text: "Perfect, we service that area. Could I get a good phone number to reach you if we need to follow up?" },
        { speaker: "caller", time: "01:37", text: "****" },
        { speaker: "agent",  time: "01:56", text: "Thank you, Jessica. I have everything in our system. I'd like to book you with one of our design consultants, I have this Thursday at 11 AM. Does that work?" },
        { speaker: "caller", time: "02:10", text: "That works great." },
        { speaker: "agent",  time: "02:14", text: "You're all set for Thursday at 11 AM. You'll get a reminder text beforehand. Thanks for choosing Shady Blinds, Jessica. Take care." },
      ],
      aiSummary: "A caller named Jessica Harper contacted Shady Blinds to schedule an in-home consultation for new window treatments after a recent move. The agent collected her name, the rooms and windows involved (living room and two bedrooms, about six windows), her product preference (wood blinds), and her timeline, confirmed the service ZIP, and captured a callback number. Jessica is a new customer; the agent booked a design consultant for the following Thursday and advised she'd receive a reminder text before the appointment. Jessica had no further questions and thanked the agent for the help.",
      comment: {
        author: "Kyle Paklaian",
        audience: "Everyone",
        date: "Jan 13, 2:55 PM",
        text: "Hey @Marcus, professional and well-structured intake with clear questions and a polite tone. Opportunity to strengthen empathy when the caller mentions moving, and be sure to capture the email (it was missed). Also briefly explain what the in-home consultation includes so the caller knows what to expect.",
      },
    },

    opsDashboard: {
      title: "Marketing and Operations Performance with Revenue",
      dateRange: "1/1/2026-1/31/2026",
      kpiGroups: [
        { title: "MARKETING DRIVEN CALLS", tiles: [
          { label: "Call Count", value: "48,293" },
          { label: "Avg. Duration", value: "2:56" },
          { label: "Avg. Revenue (Sale Amount)", value: "$786.53" },
          { label: "Total Revenue (Sale Amount)", value: "$37,984,120" },
        ]},
        { title: "NEW CUSTOMER ACQUISITION", tiles: [
          { label: "Caller Type: New Customers (Count)", value: "35,254" },
          { label: "Caller Type: New Customers (Percent)", value: "73%" },
          { label: "Consultation: Scheduled (Count)", value: "21,732" },
          { label: "Consultation: Scheduled (Percent)", value: "45%" },
        ]},
        { title: "EXISTING CUSTOMERS & RESCHEDULING", tiles: [
          { label: "Caller Type: Existing Customer (Count)", value: "13,039" },
          { label: "Caller Type: Existing Customer (Percent)", value: "27%" },
          { label: "Consultation: Canceled (Count)", value: "1,956" },
          { label: "Consultation: Canceled (Percent)", value: "9%" },
        ]},
      ],
      marketingSections: [
        {
          chartTitle: "MARKETING: Source (Consultations)",
          chart: { legend: "Consultation: Scheduled (Percent)", axisMax: 100, axisTicks: [0,20,40,60,80,100], axisSuffix: "%",
            bars: [
              { name: "Paid Search", value: 39, display: "39%" },
              { name: "Social Media", value: 41, display: "41%" },
              { name: "Organic", value: 50, display: "50%" },
              { name: "Print", value: 46, display: "46%" },
              { name: "Email", value: 76, display: "76%" },
            ] },
          tableTitle: "MARKETING: Source (Calls resulting in Consultations)",
          table: {
            columns: ["Marketing Source","Call Count","Consultation: Scheduled (Percent)","Total Revenue (Sale Amount)"],
            rows: [
              { cells: ["Paid Search","21,732","39%","$9,775,181"] },
              { cells: ["Social Media","9,659","41%","$4,845,612"] },
              { cells: ["Organic","7,244","50%","$7,725,871"] },
              { cells: ["Print","5,433","46%","$3,786,945"] },
              { cells: ["Email","4,225","76%","$11,850,511"] },
            ],
          },
        },
        {
          chartTitle: "MARKETING: Medium (Calls)",
          chart: { legend: "Call Count", axisMax: 16000, axisTicks: [0,4000,8000,12000,16000], axisSuffix: "",
            bars: [
              { name: "cpc", value: 15691, display: "15,691" },
              { name: "Organic", value: 7244, display: "7,244" },
              { name: "Bing", value: 6041, display: "6,041" },
              { name: "Brochure", value: 5433, display: "5,433" },
              { name: "Facebook", value: 5332, display: "5,332" },
              { name: "Instagram", value: 4327, display: "4,327" },
            ] },
          tableTitle: "MARKETING: Medium (Calls resulting in Consultations)",
          table: {
            columns: ["Marketing Medium","Call Count","Consultation: Scheduled (Percent)"],
            rows: [
              { cells: ["cpc","15,691","37%"] },
              { cells: ["Organic","7,244","50%"] },
              { cells: ["Bing","6,041","43%"] },
              { cells: ["Brochure","5,433","46%"] },
              { cells: ["Facebook","5,332","40%"] },
              { cells: ["Instagram","4,327","42%"] },
            ],
          },
        },
        {
          chartTitle: "MARKETING: Campaign (Calls)",
          chart: { legend: "Call Count", axisMax: 12000, axisTicks: [0,3000,6000,9000,12000], axisSuffix: "",
            bars: [
              { name: "Summer Shade Event", value: 11378, display: "11,378" },
              { name: "The Privacy Project", value: 7186, display: "7,186" },
              { name: "Design Before You Decide", value: 5389, display: "5,389" },
              { name: "Block It Out", value: 3593, display: "3,593" },
              { name: "Built for Business", value: 2395, display: "2,395" },
            ] },
          tableTitle: "MARKETING: Campaign (Calls resulting in Consultations)",
          table: {
            columns: ["Marketing Campaign","Call Count","Consultation: Scheduled (Percent)","Total Revenue (Sale Amount)"],
            rows: [
              { cells: ["Summer Shade Event","11,378","38%","$4,191,070"] },
              { cells: ["The Privacy Project","7,186","42%","$4,114,325"] },
              { cells: ["Design Before You Decide","5,389","46%","$4,190,641"] },
              { cells: ["Block It Out","3,593","54%","$4,292,190"] },
              { cells: ["Built for Business","2,395","73%","$6,761,928"] },
            ],
          },
        },
        {
          chartTitle: "MARKETING: Search Terms (Calls)",
          chart: { legend: "Call Count", axisMax: 7000, axisTicks: [0,1750,3500,5250,7000], axisSuffix: "",
            bars: [
              { name: "blinds near me", value: 6568, display: "6,568" },
              { name: "window blinds cost", value: 3941, display: "3,941" },
              { name: "plantation shutters for living room", value: 2791, display: "2,791" },
              { name: "motorized blinds smart home", value: 1970, display: "1,970" },
              { name: "commercial window treatments quote", value: 1149, display: "1,149" },
            ] },
          tableTitle: "MARKETING: Search Terms (Calls resulting in Consultations)",
          table: {
            columns: ["Marketing Search Terms","Consultation: Scheduled (Percent)"],
            rows: [
              { cells: ["blinds near me","36%"] },
              { cells: ["window blinds cost","40%"] },
              { cells: ["plantation shutters for living room","49%"] },
              { cells: ["motorized blinds smart home","59%"] },
              { cells: ["commercial window treatments quote","79%"] },
            ],
          },
        },
      ],
      webpagesTitle: "Product Categories driving New Customers",
      webpages: {
        columns: ["Product Category","Call Count","Consultation: Scheduled (Percent)","Caller Type: New Customers (Percent)"],
        rows: [
              { cells: ["Blinds","16,420","40%","74%"] },
              { cells: ["Shades","12,556","43%","71%"] },
              { cells: ["Shutters","10,142","47%","76%"] },
              { cells: ["Drapes","5,795","49%","72%"] },
              { cells: ["Services","3,380","63%","78%"] },
        ],
      },
      locationTitle: "Location Call Handling",
      locationHandling: {
        columns: ["Location","Call Count","Call Not Answered (Count)","Voice Mail (Percent)","Consultation: Scheduled (Percent)"],
        rows: [
              { cells: ["Downtown Showroom","14,488","1,217","5%","42%"] },
              { cells: ["Westside Design Center","11,590","981","5%","45%"] },
              { cells: ["North Valley Showroom","9,659","850","6%","40%"] },
              { cells: ["Harbor Point Studio","7,244","525","4%","49%"] },
              { cells: ["Riverside Gallery","5,312","290","3%","56%"] },
        ],
      },
      noBookingChart: {
        yLabel: "Call Count",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Price Above Budget", values: [1216,2067,2026,1985,1737] },
          { name: "Comparing Providers", values: [871,1556,1571,1587,1321] },
          { name: "Timing Not Right", values: [590,1065,1087,1108,931] },
          { name: "Needs Partner Approval", values: [446,780,780,780,667] },
          { name: "Outside Service Area", values: [315,541,535,530,469] },
        ],
      },
    },
    aiAgentConversion: {
      title: "AI Agent Conversion Dashboard",
      dateRange: "1/1/2026-1/31/2026",
      summary: {
        title: "AI Agent Performance Summary",
        tiles: [
          { label: "Interactions", value: "19,317" },
          { label: "Consultation Scheduled (Percent)", value: "56%" },
          { label: "Job Complete (Percent)", value: "33%" },
          { label: "Total Revenue (Sale Amount)", value: "$21,663,487" },
        ],
      },
      conversionCards: [
        { title: "LEAD FORM (Conversions): Live Agent", chips: ["Interaction Type: Form Fill", "SMS Agent Engaged: No", "Live Agent Call: Yes"],
          tiles: [{ label: "Job Complete (Percent)", value: "22%" }, { label: "Total Revenue (Sale Amount)", value: "$2,491,301" }] },
        { title: "LEAD FORM (Conversions): SMS Agent & Live Agent", chips: ["Interaction Type: Form Fill", "SMS Agent Engaged: Yes", "Live Agent Call: Yes"],
          tiles: [{ label: "Job Complete (Percent)", value: "51%" }, { label: "Total Revenue (Sale Amount)", value: "$4,116,063" }] },
        { title: "LEAD FORM (Conversions): SMS Agent Assist", chips: ["Interaction Type: Form Fill", "SMS Agent Engaged: Yes", "Live Agent Call: No"],
          tiles: [{ label: "Job Complete (Percent)", value: "70%" }, { label: "Total Revenue (Sale Amount)", value: "$3,141,206" }] },
        { title: "Voice Agent (Conversions): Live Agent", chips: ["Interaction Type: Voice", "Voice Agent Engaged: No", "Live Agent Call: Yes"],
          tiles: [{ label: "Job Complete (Percent)", value: "24%" }, { label: "Total Revenue (Sale Amount)", value: "$2,599,618" }] },
        { title: "Voice Agent (Conversions): Voice Agent & Live Agent", chips: ["Interaction Type: Voice", "Voice Agent Engaged: Yes", "Live Agent Call: Yes"],
          tiles: [{ label: "Job Complete (Percent)", value: "58%" }, { label: "Total Revenue (Sale Amount)", value: "$4,549,332" }] },
        { title: "Voice Agent (Conversions): Voice Agent", chips: ["Interaction Type: Voice", "Voice Agent Engaged: Yes", "Live Agent Call: No"],
          tiles: [{ label: "Job Complete (Percent)", value: "78%" }, { label: "Total Revenue (Sale Amount)", value: "$4,765,967" }] },
      ],
      breakdowns: [
        {
          title: "Calls by Source", tableTitle: "Source: Interaction Outcome Summary",
          dimensionColumn: "Marketing Source",
          metricColumns: ["Call Count", "Consultation Scheduled (Percent)", "Job Complete (Percent)", "Total Revenue (Sale Amount)"],
          hasDonut: true, donutTotal: 19317,
          rows: [
            { name: "Paid Search", metrics: ["8,693", "48%", "21%", "$5,653,639"] },
            { name: "Social Media", metrics: ["3,864", "51%", "26%", "$2,803,224"] },
            { name: "Organic", metrics: ["2,898", "63%", "44%", "$4,467,331"] },
            { name: "Print", metrics: ["2,173", "57%", "35%", "$2,191,336"] },
            { name: "Email", metrics: ["1,689", "93%", "91%", "$6,547,957"] },
          ],
        },
        {
          title: "Calls by Medium", tableTitle: "Medium: Call Outcome Summary",
          dimensionColumn: "Marketing Medium",
          metricColumns: ["Call Count", "Consultation Scheduled (Percent)", "Job Complete (Percent)", "Total Revenue (Sale Amount)"],
          hasDonut: true, donutTotal: 19317,
          rows: [
            { name: "cpc", metrics: ["6,276", "46%", "17%", "$3,392,550"] },
            { name: "Organic", metrics: ["2,898", "63%", "44%", "$4,467,050"] },
            { name: "Bing", metrics: ["2,416", "54%", "30%", "$2,260,732"] },
            { name: "Brochure", metrics: ["2,173", "57%", "35%", "$2,188,304"] },
            { name: "Facebook", metrics: ["2,133", "50%", "24%", "$1,429,231"] },
            { name: "Instagram", metrics: ["1,731", "52%", "28%", "$1,373,816"] },
            { name: "SFMC", metrics: ["1,690", "93%", "91%", "$6,551,804"] },
          ],
        },
        {
          title: "Calls by Campaign", tableTitle: "Campaign: Call Outcome Summary",
          dimensionColumn: "Marketing Campaign",
          metricColumns: ["Call Count", "Consultation Scheduled (Percent)", "Job Complete (Percent)", "Total Revenue (Sale Amount)"],
          hasDonut: true, donutTotal: 19317,
          rows: [
            { name: "Summer Shade Event", metrics: ["4,551", "46%", "18%", "$2,390,305"] },
            { name: "The Privacy Project", metrics: ["2,874", "52%", "27%", "$2,347,415"] },
            { name: "Design Before You Decide", metrics: ["2,156", "57%", "35%", "$2,390,408"] },
            { name: "Block It Out", metrics: ["1,437", "67%", "50%", "$2,447,183"] },
            { name: "Built for Business", metrics: ["958", "91%", "89%", "$3,855,755"] },
          ],
        },
        {
          title: "Calls by Search Term", tableTitle: "Search Term: Call Outcome Summary",
          dimensionColumn: "Marketing Search Term",
          metricColumns: ["Call Count", "Consultation Scheduled (Percent)", "Job Complete (Percent)", "Total Revenue (Sale Amount)"],
          hasDonut: true, donutTotal: 19317,
          rows: [
            { name: "blinds near me", metrics: ["2,627", "45%", "16%", "$1,044,010"] },
            { name: "window blinds cost", metrics: ["1,576", "49%", "23%", "$949,621"] },
            { name: "plantation shutters for living room", metrics: ["1,116", "62%", "42%", "$1,530,840"] },
            { name: "motorized blinds smart home", metrics: ["788", "75%", "63%", "$1,939,878"] },
            { name: "commercial window treatments quote", metrics: ["460", "93%", "92%", "$1,900,958"] },
          ],
        },
        {
          title: "Conversions by Product Category", tableTitle: "Product Category: Call Outcome Summary",
          dimensionColumn: "Product Category",
          metricColumns: ["Call Count", "Consultation Scheduled (Percent)", "Job Complete (Percent)", "Total Revenue (Sale Amount)"],
          hasDonut: false,
          rows: [
            { name: "Blinds", metrics: ["6,568", "49%", "23%", "$4,002,488"] },
            { name: "Shades", metrics: ["5,022", "53%", "29%", "$4,486,453"] },
            { name: "Shutters", metrics: ["4,057", "58%", "37%", "$6,290,161"] },
            { name: "Drapes", metrics: ["2,318", "61%", "42%", "$3,227,342"] },
            { name: "Services", metrics: ["1,352", "82%", "74%", "$3,657,043"] },
          ],
        },
      ],
      productCategoryGraph: {
        yLabel: "Job Complete (Count)",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Blinds", values: [176,324,341,354,289] },
          { name: "Shades", values: [170,313,329,342,280] },
          { name: "Shutters", values: [177,327,343,357,291] },
          { name: "Drapes", values: [114,211,222,230,188] },
          { name: "Services", values: [118,218,229,238,194] },
        ],
      },
    },

    aiMessagingImpact: {
      title: "AI Messaging Impact on Lead Capture & Revenue (Human vs AI)",
      dateRange: "1/1/2026-1/31/2026",
      aiLeadEngagement: {
        title: "AI Agent Lead Engagement (This Month)",
        tiles: [
          { label: "Form Submits", value: "24,867" },
          { label: "Avg. Speed to Lead", value: "0:00:01" },
          { label: "AI SMS Engagement Rate", value: "84%" },
        ],
      },
      aiAppointmentPerformance: {
        title: "AI Agent Consultation Performance (This Month)",
        tiles: [
          { label: "Consultation Scheduled (Percent)", value: "23%" },
          { label: "Consultation Scheduled (Count)", value: "5,719" },
          { label: "Total Revenue (Sale Amount)", value: "$19,547,318" },
        ],
      },
      humanLeadEngagement: {
        title: "Human-Only Lead Engagement (Last Month)",
        chip: "Last Month",
        tiles: [
          { label: "Form Submits", value: "21,438" },
          { label: "Avg. Speed to Lead", value: "19:23:20" },
          { label: "Human SMS Engagement Rate", value: "36%" },
        ],
      },
      humanAppointmentPerformance: {
        title: "Human Consultation Performance (Last Month)",
        chip: "Last Month",
        tiles: [
          { label: "Consultation Scheduled (Percent)", value: "3%" },
          { label: "Consultation Scheduled (Count)", value: "643" },
          { label: "Total Revenue (Sale Amount)", value: "$2,034,190" },
        ],
      },
      trendTitle: "AI-Assisted Consultation Trend",
      trendChip: "AI-Assisted Consultations",
      trendChart: {
        yLabel: "Count",
        xLabels: ["01/01","01/02","01/03","01/04","01/05","01/06","01/07","01/08","01/09","01/10","01/11","01/12","01/13","01/14","01/15","01/16","01/17","01/18","01/19","01/20","01/21","01/22","01/23","01/24","01/25","01/26","01/27","01/28","01/29","01/30","01/31"],
        series: [
          { name: "Consultation Scheduled", values: [96,101,94,99,103,97,100,95,102,98,104,141,195,227,234,227,236,229,238,232,241,234,243,236,245,238,247,241,250,243,253] },
        ],
      },
      aiOpportunities: {
        title: "AI-Assisted Opportunities",
        tiles: [
          { label: "SMS Opt-In Count", value: "21,634" },
          { label: "SMS Opt-In Rate", value: "87%" },
          { label: "Total Messages", value: "194,382" },
        ],
      },
      aiLeadNurture: {
        title: "AI Lead Nurture",
        tiles: [
          { label: "AI SMS Callback Scheduled (Count)", value: "12,631" },
          { label: "AI SMS Callback Scheduled (Percent)", value: "58%" },
          { label: "AI SMS Callback Completed (Count)", value: "12,309" },
          { label: "AI SMS Callback Completed (Percent)", value: "97%" },
        ],
      },
      commonTopicsTitle: "Common Topics",
      commonTopicsChart: {
        yLabel: "Consultation Scheduled (Count)",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Blinds", values: [230,425,446,464,379] },
          { name: "Shades", values: [176,325,341,355,290] },
          { name: "Shutters", values: [142,262,276,287,234] },
          { name: "Drapes", values: [81,150,158,164,133] },
          { name: "Motorization", values: [47,88,92,96,78] },
        ],
      },
    },

    conversationIntelligence: {
      title: "Conversation intelligence",
      dateRange: "Jan 1, 2026, Jan 31, 2026",
      callCount: "48,293 calls",
      pagerLabel: "1 of 4,829",
      calls: [
        { time: "1/5/26 9:14 am", id: "F57B-817F0292530D" },
        { time: "1/6/26 10:41 am", id: "D544-3B7FB2025A0D" },
        { time: "1/7/26 11:23 am", id: "C5B9-777FF202550D" },
        { time: "1/8/26 1:05 pm", id: "95BF-5B7FE2C2570D" },
        { time: "1/9/26 2:38 pm", id: "85B2-687FE2A2560D" },
        { time: "1/12/26 9:52 am", id: "356F-797FA282500D" },
        { time: "1/13/26 12:17 pm", id: "E53D-387F2262540D" },
        { time: "1/14/26 3:44 pm", id: "E505-A17F0272570D" },
        { time: "1/15/26 10:09 am", id: "B551-F27F9212570D" },
        { time: "1/16/26 4:26 pm", id: "A2E7-447F6142530D" },
      ],
      duration: "2:22",
      transcript: [
        { speaker: "agent",  time: "0:00", text: "Thank you for calling Shady Blinds. How can I help you today?", highlights: ["Thank you for calling", "help you today"] },
        { speaker: "caller", time: "0:04", text: "Hi, I'm hoping to get some information about new blinds for my living room windows. I just moved into a new home.", highlights: [] },
        { speaker: "agent",  time: "0:13", text: "Congratulations on the new home! I'd be happy to help. May I start by getting your first and last name?", highlights: ["first and last name"] },
        { speaker: "caller", time: "0:20", text: "Sure, it's Alicia Weber.", highlights: [] },
        { speaker: "agent",  time: "0:24", text: "Thanks, Alicia. And are you looking for a specific style, blinds, shutters, or shades?", highlights: ["shutters"] },
        { speaker: "caller", time: "0:31", text: "I think I want something that blocks a lot of light. The living room gets really bright in the afternoon.", highlights: [] },
        { speaker: "agent",  time: "0:40", text: "In that case I'd recommend our plantation shutters or cellular shades, both give you excellent light control. Do you know roughly how many windows you'd like to cover?", highlights: ["plantation shutters", "cellular shades"] },
        { speaker: "caller", time: "0:52", text: "There are three large windows and one smaller one by the front door.", highlights: [] },
        { speaker: "agent",  time: "1:00", text: "Perfect. The best way to get you accurate pricing is a free in-home consultation, where a design consultant brings samples and measures everything. There's no cost or obligation.", highlights: ["free in-home consultation", "measures everything", "no cost or obligation"] },
        { speaker: "caller", time: "1:12", text: "That sounds great. How soon could someone come out?", highlights: [] },
        { speaker: "agent",  time: "1:16", text: "Let me check availability. Are you a new customer with us, or have you ordered before?", highlights: ["new customer"] },
        { speaker: "caller", time: "1:21", text: "New, this is my first time calling.", highlights: [] },
        { speaker: "agent",  time: "1:25", text: "Wonderful, welcome to Shady Blinds. I have an opening this Thursday at 10 AM or Friday at 2 PM. Which works better?", highlights: ["this Thursday at 10 AM"] },
        { speaker: "caller", time: "1:34", text: "Thursday at 10 works for me.", highlights: [] },
        { speaker: "agent",  time: "1:38", text: "Great, I've scheduled your consultation for Thursday at 10 AM. Can I get the best phone number and your address?", highlights: ["scheduled your consultation"] },
        { speaker: "caller", time: "1:46", text: "Yes, it's 148 Maple Avenue, and my number is the one I'm calling from.", highlights: [] },
        { speaker: "agent",  time: "1:54", text: "Got it. You'll receive a confirmation text, and our consultant will call when they're on the way. Is there anything else I can help you with?", highlights: ["confirmation text", "anything else I can help"] },
        { speaker: "caller", time: "2:06", text: "No, that's everything. Thank you so much!", highlights: [] },
        { speaker: "agent",  time: "2:10", text: "You're very welcome, Alicia. Thank you for calling Shady Blinds, and we'll see you Thursday. Have a great day!", highlights: ["Thank you for calling Shady Blinds", "Have a great day"] },
      ],
      signals: [
        { name: "(QA) Proper Close",              badges: ["Keyword Spotting","Rule"],           count: 4 },
        { name: "(QA) Proper Greeting",           badges: ["Keyword Spotting","Rule"],           count: 2 },
        { name: "Answered by Agent",              badges: ["Rule"],                              count: 0 },
        { name: "Consultation: Scheduled",        badges: ["Keyword Spotting","Rule"],           count: 1 },
        { name: "Business Hours: Inside",         badges: ["Rule"],                              count: 0 },
        { name: "Caller Type: New Customer",      badges: ["Keyword Spotting","Rule","Keypress"], count: 1 },
        { name: "Free Consultation Offered",      badges: ["Keyword Spotting","Rule"],           count: 1 },
        { name: "In-Home Measurement Discussed",  badges: ["Keyword Spotting"],                  count: 1 },
        { name: "Product Interest: Shutters",     badges: ["Keyword Spotting"],                  count: 2 },
      ],
      scoreValue: 82,
      scoreLabel: "BASE SKILLS",
      aiSummary: {
        summary: "Alicia Weber, a new customer who recently moved into a new home, called Shady Blinds looking for light-blocking window treatments for her living room, which gets very bright in the afternoon. The agent identified four windows, three large plus one smaller by the front door, and recommended plantation shutters or cellular shades for the best light control. To provide accurate pricing, the agent booked a free, no-obligation in-home consultation for Thursday at 10 AM and captured Alicia's address and callback number. The call closed positively with a confirmation text promised and a warm sign-off.",
        keyPoints: [
          "New customer, first time contacting Shady Blinds",
          "Wants strong light control for a bright living room",
          "Four windows total (three large, one small by the front door)",
          "Agent recommended plantation shutters and cellular shades",
          "Free in-home consultation booked for Thursday at 10 AM",
          "Captured address (148 Maple Avenue) and callback number; confirmation text to follow",
        ],
        sentiment: "Positive",
        outcome: "Consultation booked, Thursday 10 AM",
      },
    },
    smsConversationIntelligence: {
      countLabel: "18,367 conversations",
      dateRange: "Jan 1, 2026, Jan 31, 2026",
      pagerLabel: "1 of 1,837",
      conversations: [
        {
          id: "C516-117FE212560D",
          time: "1/13/26 10:55 am",
          active: true,
          date: "January 14, 2026",
          transcript: [
            { speaker: "agent",    time: "6:21 AM", text: "Hi there! I'm the AI assistant for Shady Blinds, here to help you get a personalized quote for custom window treatments. Schedule a consultation today and save 10% on wood blinds. Would you like to get started?" },
            { speaker: "consumer", time: "6:21 AM", text: "Yes" },
            { speaker: "agent",    time: "6:22 AM", text: "Great! First, how many windows are you looking to cover?" },
            { speaker: "consumer", time: "6:22 AM", text: "About 6 windows in my living room and kitchen" },
            { speaker: "agent",    time: "6:22 AM", text: "Perfect. Roughly what are the measurements of those windows?" },
            { speaker: "consumer", time: "6:23 AM", text: "Most are around 36 by 48 inches" },
            { speaker: "agent",    time: "6:23 AM", text: "Got it. What material are you considering, wood, faux wood, shutters, or shades?" },
            { speaker: "consumer", time: "6:24 AM", text: "Wood blinds" },
            { speaker: "agent",    time: "6:24 AM", text: "Nice choice. And what's your timeline for getting these installed?" },
            { speaker: "consumer", time: "6:24 AM", text: "Within the next month or so" },
            { speaker: "agent",    time: "6:25 AM", text: "Last thing, what's your ZIP code so I can confirm we service your area?" },
            { speaker: "consumer", time: "6:25 AM", text: "93101" },
            { speaker: "agent",    time: "6:26 AM", text: "Good news, we service the 93101 area! Based on 6 wood blinds at 36 by 48 inches, a preliminary estimate is around $1,400 to $1,900 before your 10% discount. For an exact quote, we recommend a virtual consultation with a specialist. Would you like to schedule one?" },
            { speaker: "consumer", time: "6:27 AM", text: "Yes please" },
            { speaker: "agent",    time: "6:27 AM", text: "I have availability this Thursday at 11:00 AM Pacific. Would you like me to lock that in?" },
            { speaker: "consumer", time: "6:28 AM", text: "That works" },
            { speaker: "agent",    time: "6:28 AM", text: "You're all set for Thursday at 11:00 AM. You'll get a reminder text 5 minutes before with the number to call: 805-888-2424. Thank you for choosing Shady Blinds!" },
          ],
          signals: [
            { name: "Service Area: Confirmed",     badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Estimate Provided",           badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Consultation: Scheduled",     badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Caller Type: New Customer",   badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Discount Offered",            badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Qualified Lead",              badges: ["Rule"],                    count: 0 },
            { name: "Product Interest: Wood Blinds", badges: ["Keyword Spotting"],      count: 2 },
          ],
          smsInfo: {
            callRecordId: "C516-117FE212560D",
            smsStartTime: "1/14/26 10:21 am",
            destinationPhone: "877-936-2933",
            totalMessages: "17",
            source: "877-936-2933",
            promoNumberDescription: "SMS",
            smsEngaged: "Yes",
            smsOptIn: "Yes",
            smsOptOut: "No",
            sessionStatus: "Active",
            callerId: "805-555-0142",
            repeatCaller: "No",
            city: "Santa Barbara",
            region: "CA",
            phoneType: "Mobile",
            displayName: "J Harper",
            firstName: "Jessica",
            lastName: "Harper",
            gender: "Female",
            destinationTimeZone: "Pacific Time (US & Canada)",
            finalCampaign: "Default: SMS Campaign",
            finalCampaignId: "9970305",
          },
        },
        { id: "35D7-DE7FD202520D", time: "1/13/26 10:55 am", active: false, date: "", transcript: [], signals: [] },
        { id: "05C9-E27FD262560D", time: "1/13/26 10:55 am", active: false, date: "", transcript: [], signals: [] },
        { id: "E5B7-BF7FC2B25F0D", time: "1/13/26 10:52 am", active: false, date: "", transcript: [], signals: [] },
      ],
    },

    voiceConversationIntelligence: {
      countLabel: "9,684 calls",
      dateRange: "Jan 1, 2026, Jan 31, 2026",
      pagerLabel: "1 of 968",
      conversations: [
        {
          id: "A417-2C9FE314770D",
          time: "1/13/26 4:12 am",
          active: true,
          date: "January 14, 2026",
          transcript: [
            { speaker: "agent",    time: "4:12 PM", text: "Hi there, thanks for calling Shady Blinds! I'm the AI assistant here, and I can help you get a personalized quote for custom window treatments. Right now, if you schedule a consultation today, you'll save ten percent on wood blinds. Would you like to get started?" },
            { speaker: "consumer", time: "4:12 PM", text: "Yeah, sure." },
            { speaker: "agent",    time: "4:12 PM", text: "Great! First, how many windows are you looking to cover?" },
            { speaker: "consumer", time: "4:13 PM", text: "About six, in my living room and kitchen." },
            { speaker: "agent",    time: "4:13 PM", text: "Perfect. And roughly what are the measurements of those windows?" },
            { speaker: "consumer", time: "4:13 PM", text: "Most of them are around thirty-six by forty-eight inches." },
            { speaker: "agent",    time: "4:14 PM", text: "Got it. What material are you considering, wood, faux wood, shutters, or shades?" },
            { speaker: "consumer", time: "4:14 PM", text: "I think wood blinds." },
            { speaker: "agent",    time: "4:14 PM", text: "Nice choice. And what's your timeline for getting these installed?" },
            { speaker: "consumer", time: "4:15 PM", text: "Sometime in the next month." },
            { speaker: "agent",    time: "4:15 PM", text: "Last thing, what's your ZIP code, so I can confirm we service your area?" },
            { speaker: "consumer", time: "4:15 PM", text: "Nine three one oh one." },
            { speaker: "agent",    time: "4:16 PM", text: "Good news, we service the nine three one oh one area! Based on six wood blinds around thirty-six by forty-eight inches, a preliminary estimate would be roughly fourteen hundred to nineteen hundred dollars, before your ten percent discount. For an exact quote, I'd recommend a quick virtual consultation with a specialist. Would you like to schedule one?" },
            { speaker: "consumer", time: "4:17 PM", text: "Yeah, let's do that." },
            { speaker: "agent",    time: "4:17 PM", text: "I have availability this Thursday at eleven A M Pacific. Would you like me to lock that in?" },
            { speaker: "consumer", time: "4:17 PM", text: "That works for me." },
            { speaker: "agent",    time: "4:18 PM", text: "You're all set for Thursday at eleven A M. You'll get a reminder text five minutes before, with a number you can call: eight oh five, eight eight eight, two four two four. Thanks so much for choosing Shady Blinds!" },
          ],
          signals: [
            { name: "Service Area: Confirmed",       badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Estimate Provided",             badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Consultation: Scheduled",       badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Caller Type: New Customer",     badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Discount Offered",              badges: ["Keyword Spotting","Rule"], count: 1 },
            { name: "Qualified Lead",                badges: ["Rule"],                    count: 0 },
            { name: "Product Interest: Wood Blinds", badges: ["Keyword Spotting"],        count: 2 },
          ],
          voiceInfo: {
            callRecordId: "A417-2C9FE314770D",
            callStartTime: "1/14/26 2:12 pm",
            duration: "5:47",
            destinationPhone: "877-936-2933",
            source: "805-336-1120",
            promoNumberDescription: "Voice, Paid Search",
            connectionStatus: "Connected",
            callerId: "805-555-0142",
            repeatCaller: "No",
            city: "Santa Barbara",
            region: "CA",
            phoneType: "Mobile",
            displayName: "J Harper",
            firstName: "Jessica",
            lastName: "Harper",
            gender: "Female",
            destinationTimeZone: "Pacific Time (US & Canada)",
            finalCampaign: "Default: Voice Campaign",
            finalCampaignId: "9970118",
          },
        },
        { id: "72F1-A38FC1B4630D", time: "1/13/26 3:58 am", active: false, date: "", transcript: [], signals: [] },
        { id: "1D8E-5B7FD0C4510D", time: "1/13/26 3:41 am", active: false, date: "", transcript: [], signals: [] },
        { id: "C0A9-9E4FE2A47F0D", time: "1/13/26 3:19 am", active: false, date: "", transcript: [], signals: [] },
      ],
    },
    agentConfig: {
      serviceArea: "the greater Santa Barbara, California area, ZIP codes starting with 931 (and nearby 930xx), roughly Santa Barbara County",
      brandConversationRules: [
        "Intro + offer: Introduce yourself as Shady Blinds' AI agent helping with a personalized quote, and mention that scheduling a consultation today saves 10% on wood blinds. Ask if they'd like to get started.",
        "Qualify one question at a time: how many windows they're covering, the approximate measurements of each, the material they're considering (wood, faux wood, shutters, shades), their timeline, and their ZIP code to confirm service availability.",
        "Estimate then book: Confirm you service their ZIP, give a preliminary price range based on what they shared, then recommend a virtual consultation with a specialist for an exact quote. Propose a specific day and time, lock it in, and confirm they'll get a reminder text 5 minutes before with a number to call (805-888-2424).",
      ],
      knowledgeSources: [
        { name: "Shady_Blinds_Sales_Playbook.pdf",                 type: "Document", lastUpdated: "03/11/2026 10:21 AM" },
        { name: "https://www.shadyblindsnow.com",                  type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
        { name: "https://www.shadyblindsnow.com/blinds/",          type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
        { name: "https://www.shadyblindsnow.com/shutters/",        type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
        { name: "https://www.shadyblindsnow.com/free-consultation/", type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
      ],
      smsPlaybook: {
        goal: "Qualify the customer's window-treatment needs, share a preliminary price range, and schedule a virtual consultation with a specialist for an exact quote.",
        bookingType: "virtual consultation",
        offer: "Schedule a consultation today to save 10% on wood blinds",
        providesEstimate: true,
        qualifyingQuestions: [
          "how many windows they're looking to cover",
          "the approximate measurements of each window",
          "the material they're considering (wood, faux wood, shutters, or shades)",
          "their timeline for the project",
          "their ZIP code, to confirm service availability",
        ],
      },
      aiRecommendations: [
        {
          title: "Qa pairs - 2026-03-11 13:12",
          updated: "07/09/2026 3:29 PM",
          enabled: true,
          payload: `{"task_data_type":"application/json","EXISTING_CUSTOMER":[{"topic":"File Warranty Claim","question":"How do I file a warranty claim for my blinds?","answer":"I can help you file a warranty claim. I'll need your full name, phone number, email address, and the complete address where the blinds are installed. Please confirm these details and briefly describe the issue you're seeing."},{"topic":"Reschedule Installation","question":"Can I move my installation date?","answer":"Absolutely, I can reschedule your installation. What day and time window works best for you? I'll check the next available slots for your area."}]}`,
          qaPairs: [
            { question: "How do I schedule a free in-home consultation?", answer: "I can set that up right now, a design consultant will bring samples and measure your windows at no cost or obligation. What day and time window works best for you?" },
            { question: "What types of window treatments do you offer?", answer: "We offer blinds, shades, plantation shutters, and custom drapery in a wide range of materials and colors. Tell me the room and the look you're going for and I'll point you to the best fit." },
            { question: "How much do your blinds cost?", answer: "Pricing depends on the product, window size, and how many windows you're covering, so we confirm exact pricing at your free in-home consultation where you'll see samples and get an accurate quote." },
            { question: "Do you offer financing?", answer: "Yes, we offer financing options, including plans with no interest for qualified customers. Your consultant can walk through the details during your appointment." },
            { question: "How long does installation take?", answer: "Most installations are completed in a single visit, scheduled once your custom order arrives. The exact time depends on the number of windows." },
            { question: "Do you offer motorized or smart blinds?", answer: "Yes, we offer motorized shades and blinds you can control with a remote, an app, or a voice assistant. I'd be happy to include those in your consultation." },
            { question: "Are your window treatments child-safe?", answer: "Yes, we offer cordless and motorized options that are safer for homes with children and pets. Your consultant can recommend the best child-safe styles for your rooms." },
            { question: "Can I get blackout options for my bedroom?", answer: "Absolutely, we offer blackout shades, cellular shades, and lined drapery that block light for better sleep. I'll note that for your consultation." },
            { question: "What's the difference between faux wood and real wood blinds?", answer: "Faux wood is moisture-resistant and great for bathrooms and kitchens, while real wood offers a premium look for living spaces. We can show you both at your appointment." },
            { question: "Do you handle custom or unusually shaped windows?", answer: "Yes, we specialize in custom-fit treatments for arched, bay, and specialty windows. Your consultant measures precisely so everything fits perfectly." },
            { question: "Can someone bring samples to my home?", answer: "Yes, our free in-home consultation includes samples so you can see colors and materials in your own lighting. Would you like to schedule one?" },
            { question: "What's the status of my order?", answer: "I can check that for you. Please confirm your full name and the phone number or email on the order and I'll pull up the latest status and estimated delivery." },
            { question: "Can I reschedule my installation appointment?", answer: "Of course, what day and time window works better for you? I'll find the next available slot for your area." },
            { question: "How do I file a warranty claim?", answer: "I can help with that. I'll need your full name, phone number, email, and the address where the treatments are installed, plus a brief description of the issue you're seeing." },
            { question: "What areas do you service?", answer: "We serve the greater metro area and surrounding communities. Share your city or zip code and I'll confirm we cover your location." },
            { question: "How do I care for and clean my blinds?", answer: "Most blinds can be dusted with a soft cloth or vacuumed with a brush attachment. We'll share care tips specific to your product at installation." },
            { question: "Do you offer energy-efficient window treatments?", answer: "Yes, our cellular (honeycomb) shades trap air to improve insulation and help lower energy costs. Your consultant can recommend the most efficient options." },
            { question: "Can I cancel or change my order?", answer: "Changes may be possible depending on where your custom order is in production. Share your order details and I'll check what options are available." },
            { question: "Do you have a showroom I can visit?", answer: "Many customers prefer our free in-home consultation since you see samples in your own space, but I can share showroom details if you'd like to visit in person." },
            { question: "How soon can someone come out?", answer: "I often have availability within the next few days, sometimes as soon as tomorrow. What day and time window works best for you?" },
          ],
        },
        {
          title: "Intent follow up - 2026-03-11 13:12",
          updated: "07/09/2026 3:29 PM",
          enabled: false,
          payload: `{"task_data_type":"application/json","NEW_CUSTOMER":[{"intent":"Schedule Installation","follow_up_message":"Great news! We've confirmed your in-home consultation appointment. Our design specialist will assess your windows and provide a detailed quote. We'll send you a confirmation text shortly with all the details."},{"intent":"Request Quote","follow_up_message":"Thanks for your interest in Shady Blinds! To put together an accurate quote, we'd love to schedule a free in-home consultation so we can measure your windows and show you samples. What day works best?"}]}`,
        },
      ],
    },
    /* Quality Management dashboard (5th) — QA/scorecard insights, re-skinned to
       window treatments. Platform metric labels kept verbatim; agent names,
       scorecard skills and window-treatment terms are the prospect's. */
    qualityManagement: {
      title: "QM | Actionable Insights Dashboard",
      dateRange: "1/1/2026-1/31/2026",
      salesOpportunities: {
        title: "Sales Opportunities",
        chips: ["Answered by Agent: Yes"],
        tiles: [
          { label: "Call Count", value: "44,430" },
          { label: "Buying Intent (Industry) (Count)", value: "26,658" },
        ],
      },
      salesConversions: {
        title: "Sales Conversions",
        chips: ["2 Filters"],
        tiles: [
          { label: "Consultation Booked (Count)", value: "21,732" },
          { label: "Total Revenue (Sale Amount)", value: "$37,984,120" },
        ],
      },
      callsNeedingReview: {
        title: "Calls Needing Review, Lost Sales Opportunities",
        chips: ["5 Filters"],
        chart: {
          legend: "New Customer Sales Fail (Range & Count)",
          axisMax: 300,
          axisTicks: [0, 75, 150, 225, 300],
          axisSuffix: "",
          bars: [
            { name: "Joshua Young", value: 247, display: "247" },
            { name: "Olivia King", value: 239, display: "239" },
            { name: "Michael Thompson", value: 233, display: "233" },
            { name: "James Reynolds", value: 226, display: "226" },
            { name: "Lauren Sanchez", value: 214, display: "214" },
          ],
        },
      },
      highestConvertingAgents: {
        yLabel: "Consultation Booked (Count)",
        xLabels: ["Jan 1-4","Jan 5-11","Jan 12-18","Jan 19-25","Jan 26-31"],
        series: [
          { name: "Victoria Murphy", values: [120,221,233,242,198] },
          { name: "Jessica Roberts", values: [114,210,221,229,187] },
          { name: "Sophia Bennett", values: [115,211,222,231,189] },
          { name: "Emily Davis", values: [105,193,203,211,171] },
          { name: "Daniel Wright", values: [107,197,207,215,176] },
        ],
      },
      baselineSkills: {
        title: "Baseline Skills",
        chips: [],
        tiles: [
          { label: "Proper Greeting (Scorecard) (Percent)", value: "95%" },
          { label: "Asked for the Sale (Scorecard) (Percent)", value: "62%" },
        ],
      },
      scoredCalls: {
        title: "Scored Calls",
        chips: [],
        tiles: [
          { label: "Information Gathering (Average)", value: "64.5%" },
          { label: "Call Etiquette (Average)", value: "92.3%" },
          { label: "New Customer Sales (Average)", value: "71%" },
        ],
      },
      baselineQualityScore: {
        title: "Baseline Sales Quality Score",
        cadence: "Daily",
        barLabel: "New Customer Sales Combination Scorecard (Average)",
        average: 71,
        yMax: 100,
        yTicks: [0, 25, 50, 75, 100],
        suffix: "%",
        points: qmDays(71, 8, 0, 0, false),
      },
      bottomByAgentBar: {
        title: "Bottom Quality Scores by Agent",
        chips: ["New Customer Sales Combination Scorecard: Applied"],
        chart: {
          legend: "New Customer Sales Combination Scorecard",
          axisMax: 100,
          axisTicks: [0, 25, 50, 75, 100],
          axisSuffix: "%",
          bars: [
            { name: "Joshua Young", value: 52.4, display: "52.4%" },
            { name: "Olivia King", value: 54.1, display: "54.1%" },
            { name: "Michael Thompson", value: 55.8, display: "55.8%" },
            { name: "James Reynolds", value: 57.3, display: "57.3%" },
            { name: "Lauren Sanchez", value: 59.0, display: "59.0%" },
            { name: "Samantha Foster", value: 60.6, display: "60.6%" },
          ],
        },
        pager: "1 - 6 of 30",
      },
      bottomByAgentTable: {
        title: "Bottom Quality Scores by Agent",
        chips: ["New Customer Sales Combination Scorecard: Applied"],
        table: {
          columns: ["Agent", "New Customer Sales Combination Scorecard (Average)", "Consultation Booked (Percent)", "Total Revenue (Sale Amount)", "Call Count"],
          rows: [
            { cells: ["Joshua Young", "52.4%", "26%", "$630,971", "1,387"] },
            { cells: ["Olivia King", "54.1%", "28%", "$695,641", "1,423"] },
            { cells: ["Michael Thompson", "55.8%", "30%", "$765,555", "1,461"] },
            { cells: ["James Reynolds", "57.3%", "31%", "$763,807", "1,409"] },
            { cells: ["Lauren Sanchez", "59.0%", "33%", "$859,939", "1,492"] },
            { cells: ["Samantha Foster", "60.6%", "35%", "$879,165", "1,438"] },
          ],
        },
      },
      topByAgentBar: {
        title: "Top Quality Scores by Agent",
        chips: [],
        chart: {
          legend: "New Customer Sales Combination Scorecard",
          axisMax: 100,
          axisTicks: [0, 25, 50, 75, 100],
          axisSuffix: "%",
          bars: [
            { name: "Victoria Murphy", value: 93.8, display: "93.8%" },
            { name: "Jessica Roberts", value: 92.5, display: "92.5%" },
            { name: "Sophia Bennett", value: 91.1, display: "91.1%" },
            { name: "Emily Davis", value: 89.7, display: "89.7%" },
            { name: "Daniel Wright", value: 88.4, display: "88.4%" },
            { name: "Brian Walker", value: 87.0, display: "87.0%" },
          ],
        },
        pager: "1 - 6 of 30",
      },
      qualityByAgentTable: {
        title: "Quality Scores by Agent",
        chips: [],
        table: {
          columns: ["Agent", "New Customer Sales Combination Scorecard (Average)", "Consultation Booked (Percent)", "Total Revenue (Sale Amount)", "Call Count"],
          rows: [
            { cells: ["Victoria Murphy", "93.8%", "67%", "$1,772,313", "1,514"] },
            { cells: ["Jessica Roberts", "92.5%", "65%", "$1,679,677", "1,479"] },
            { cells: ["Sophia Bennett", "91.1%", "63%", "$1,691,912", "1,536"] },
            { cells: ["Emily Davis", "89.7%", "61%", "$1,543,345", "1,447"] },
            { cells: ["Daniel Wright", "88.4%", "60%", "$1,576,554", "1,503"] },
            { cells: ["Brian Walker", "87.0%", "58%", "$1,485,666", "1,466"] },
          ],
        },
      },
      trendingToConversion: {
        title: "Trending Sales Quality Score to Conversion",
        cadence: "Daily",
        barLabel: "New Customer Sales Combination Scorecard (Average)",
        lineLabel: "Consultation Booked (Count)",
        yMax: 100,
        yTicks: [0, 25, 50, 75, 100],
        suffix: "%",
        rightLabel: "Consultation Booked (Count)",
        rightMax: 1000,
        rightTicks: [0, 250, 500, 750, 1000],
        // bars = scorecard %, line = consultations booked/day summing to the KPI
        points: qmDays(71, 8, 701, 90, true, 21732),
      },
      trendingToRevenue: {
        title: "Trending Sales Quality Score to Revenue",
        cadence: "Daily",
        barLabel: "New Customer Sales Combination Scorecard (Average)",
        lineLabel: "Total Revenue (Sale Amount)",
        yMax: 100,
        yTicks: [0, 25, 50, 75, 100],
        suffix: "%",
        rightLabel: "Total Revenue (Sale Amount)",
        rightMax: 1800000,
        rightTicks: [0, 600000, 1200000, 1800000],
        rightPrefix: "$",
        // bars = scorecard %, line = revenue/day summing to the period total
        points: qmDays(71, 8, 1225294, 160000, true, 37984120),
      },
    },
    /* QM Instant Insights dashboard (6th) — QA at-a-glance. QA/contact-center
       metric labels kept verbatim; evaluator names generic. */
    qmInstantInsights: {
      title: "QM | Instant Insights Dashboard",
      dateRange: "1/1/2026-1/31/2026",
      trendingEssentialMetrics: {
        title: "Trending Essential Metrics",
        cadence: "Daily",
        barLabel: "Negative Sentiment (Percent)",
        lineLabel: "Average Agent Handle Time",
        linePrimary: true,
        yMin: 78,
        yMax: 105,
        yTicks: [80, 88, 96, 104],
        suffix: "",
        tickLabels: ["1:20", "1:28", "1:36", "1:44"],
        // Line = AHT seconds (left time axis); bars = Negative Sentiment % on the right.
        rightLabel: "Negative Sentiment (Percent)",
        rightMax: 20,
        rightTicks: [0, 5, 10, 15, 20],
        rightSuffix: "%",
        points: (() => {
          const p = qmDays(6, 3, 89, 6, true);
          /* One bad day, applied MEAN-NEUTRALLY: whatever the spike adds is taken
             back a unit at a time across other days, so the tiles above ("1:29"
             average handle time, the negative-sentiment count) stay exactly true
             of the series. Poking a point without this quietly shifted both. */
          const spike = (key: "bar" | "line", at: number, to: number) => {
            let debt = to - (p[at][key] as number);
            p[at][key] = to;
            for (let j = 1; debt > 0 && j < p.length; j++) {
              const q = p[(at + j * 7) % p.length];
              if (q === p[at] || (q[key] as number) <= 1) continue;
              q[key] = (q[key] as number) - 1;
              debt--;
            }
          };
          spike("line", 12, 101); // the AHT spike
          spike("bar", 12, 14);   // the one tall negative-sentiment day
          return p;
        })(),
      },
      essentialMetrics: {
        title: "Essential Metrics",
        chips: [],
        tiles: [
          { label: "Call Count", value: "48,293" },
          { label: "Average Agent Handle Time", value: "1:29" },
          { label: "Not Answered by Agent (Count)", value: "3,863" },
          { label: "Negative Sentiment (Count)", value: "2,898" },
        ],
      },
      trendingAnswerRate: {
        title: "Trending Answer Rate",
        cadence: "Daily",
        lineLabel: "Answered by Agent (Percent)",
        linePrimary: true,
        yMin: 80,
        yMax: 100,
        yTicks: [80, 85, 90, 95, 100],
        suffix: "%",
        points: qmDays(0, 0, 92, 3, true).map((p) => ({ label: p.label, line: p.line })),
      },
      contactCenterMetrics: {
        title: "Contact Center Metrics",
        chips: [],
        tiles: [
          { label: "Caller Talk Time %", value: "32%" },
          { label: "Agent Talk Time %", value: "59%" },
          { label: "Average Overtalk Time", value: "0:00" },
          { label: "Silence Time %", value: "9%" },
        ],
      },
      overallEvaluationScore: {
        title: "Overall Evaluation Score",
        chips: [],
        tiles: [{ label: "QA Evaluation Form (Average)", value: "82%" }],
      },
      evaluationRollup: {
        title: "Evaluation Rollup",
        chips: [],
        tiles: [
          { label: "Introduction (Average)", value: "84.71%" },
          { label: "Phone Etiquette (Average)", value: "88.9%" },
          { label: "Problem Resolution (Average)", value: "71.87%" },
        ],
      },
      scoredCallsByEvaluator: {
        title: "Scored Calls by Evaluator",
        chips: [],
        table: {
          columns: ["Evaluated By", "Evaluated (Count)", "Introduction (Average)", "Phone Etiquette (Average)", "Problem Resolution (Average)"],
          rows: [
            { cells: ["Kathy Bui", "417", "88.4%", "91.2%", "74.6%"] },
            { cells: ["Sarah Weingart", "383", "84.1%", "88.7%", "71.3%"] },
            { cells: ["Brandon McCarty", "251", "79.5%", "85.4%", "68.2%"] },
          ],
        },
      },
    },
    /* Gumloop leave-behinds — 3 HTML artifacts an external Gumloop agent builds
       from just the customer URL, in parallel with the platform demo. Seeded
       here so the My Reports rows + iframe route work before the live Gumloop
       trigger is wired. Two are "complete" (self-contained html); one is left
       "creating" to show the in-progress state in the Schedule Status column. */
    gumloopArtifacts: [
      {
        id: "voice-screenpop",
        name: "Voice Screenpop",
        status: "complete",
        createdAt: "6/25/26 7:46 am",
        // Rendered live from reports.voiceScreenpop (below) via src/artifacts.
      },
      {
        id: "sms-screenpop",
        name: "SMS Screenpop",
        status: "complete",
        createdAt: "6/25/26 7:46 am",
        // Rendered live from reports.smsScreenpop (below) via src/artifacts.
      },
      {
        id: "voice-routing-demo",
        name: "Voice Routing Demo",
        status: "complete",
        createdAt: "6/25/26 7:46 am",
        // Rendered live from reports.voiceRoutingDemo (below) via src/artifacts.
      },
    ],
    /* Voice Screenpop artifact data — re-skinned to window treatments. Rendered
       into the CTI screen-pop HTML by src/artifacts/voiceScreenpop.ts. */
    voiceScreenpop: {
      brandName: "Shady Blinds",
      callerName: "Jessica Harper",
      callerPhone: "(805) 555-0142",
      campaign: "Custom Window Treatments, Santa Barbara Acquisition",
      tagGreen: "✓ In Service Area",
      tagBlue: "New Consultation Lead",
      estimatedValue: "$2,485",
      googleSearch: "custom motorized shades near me",
      websiteSearch: "motorized shades installation cost",
      callingWebpage: "/motorized-shades",
      products: "Motorized Shades, Plantation Shutters",
      cartId: "SB-4827K",
      serviceable: "Yes",
      email: "j.harper@gmail.com",
      street: "3275 Cliff Drive",
      city: "Santa Barbara",
      state: "CA",
      zip: "93109",
      digitalJourney: "/home › /motorized-shades › /request-consultation › /motorized-shades",
      intent: "Motorized Shades, homeowner seeking whole-home motorization quote",
      coverage: "ZIP 93109 confirmed, Santa Barbara serviceable",
      switchIntent: "High, remodeling now, wants an in-home consultation this week",
      greeting:
        "Hi Jessica, thanks for calling Shady Blinds where we design and install custom window treatments. I see you're looking at motorized shades for your home in Santa Barbara. I'd love to book you a free in-home consultation so we can measure your windows and show you samples.",
    },
    /* SMS Screenpop artifact data — re-skinned to window treatments. Rendered
       into the CTI screen-pop HTML by src/artifacts/smsScreenpop.ts. */
    smsScreenpop: {
      brandName: "Shady Blinds",
      callerName: "Marcus Bell",
      callerPhone: "(805) 555-0198",
      campaign: "Plantation Shutters, Spring Promo",
      tagGreen: "✓ In Service Area",
      tagBlue: "New Consultation Lead",
      estimatedValue: "$3,275",
      googleSearch: "plantation shutters installation goleta",
      websiteSearch: "custom shutters quote 4 windows",
      callingWebpage: "/plantation-shutters",
      products: "Plantation Shutters, Roman Shades",
      cartId: "SB-5193M",
      serviceable: "Yes",
      email: "m.bell@gmail.com",
      street: "812 Cathedral Oaks Road",
      city: "Goleta",
      state: "CA",
      zip: "93117",
      digitalJourney: "/home › /plantation-shutters › /request-consultation › /plantation-shutters",
      intent: "Plantation Shutters, homeowner wants a quote on 4 windows",
      coverage: "ZIP 93117 confirmed, Goleta serviceable",
      appointment: "In-home consultation w/ design consultant, Thu Jul 17, 10:00 AM",
      greeting:
        "Hi Marcus, this is Danielle from Shady Blinds following up on your text. I see we've booked your free in-home consultation for Thursday, July 17 at 10:00 AM so our design consultant can measure your 4 windows and show you plantation shutter samples. I'm here if you have any questions before then.",
    },
    /* Voice Routing Demo artifact data — re-skinned to window treatments.
       Rendered into the animated routing HTML by src/artifacts/voiceRoutingDemo.ts.
       queues[0] ("Design Consultation") is the winning route. */
    signalManager: {
      title: "Signal",
      uploadTitle: "Upload Signal Records",
      uploadBody: "Go here to upload Signal and/or revenue amounts to Invoca calls",
      apiTitle: "View API Documentation",
      apiBody: "Learn about how to post Signals and revenue from another system",
      filterLabel: "All Signals",
      pagerLabel: "1 - 10 of 10",
      rowsPerPage: "100",
      /* Ten signals covering the three groups an SE walks through — CONVERSIONS
         (what the business counts as won, tagged "Conversion"), QUALITY (the
         scorecard-backed coaching ones) and PRODUCT / INTENT (what the caller
         wanted or objected to). Rule expressions use the real Signal syntax from
         the captured page, with the spotted phrases re-skinned to window
         treatments — that string is what makes this read as the actual product.

         Sorted by NAME, like the real grid, so the groups interleave; the
         Tagged As column is what makes the conversions pick out visually. */
      signals: [
        /* The primary conversion leads — it's the row the demo drills into.
           The rest are name-sorted, as the real grid is. The screen enforces
           this order too, so a generated prospect gets it regardless. */
        { name: "Consultation Booked (Conversion)", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "2 Signals", description: "", taggedAs: "Conversion", revenue: "",
          rules: 'voice_signal = any(1, ["see you Thursday (Agent)", "schedule your consultation (Agent)", "book the in-home (Agent)", "get a designer out (Agent)"])',
          createdAt: "12/13/25 11:00 am", updatedAt: "01/14/26 9:12 am" },
        { name: "Competitor Mentioned", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["budget blinds (Caller)", "3 day blinds (Caller)", "the home depot (Caller)", "another quote (Caller)"])',
          createdAt: "02/11/25 5:24 pm", updatedAt: "01/06/26 8:10 pm" },
        { name: "Compliance: Quoted Price Disclosure", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "1 Scorecard", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["price includes measure and install (Agent)", "quote is good for (Agent)", "no obligation (Agent)"])',
          createdAt: "05/17/25 10:08 am", updatedAt: "01/13/26 8:41 am" },
        { name: "Consultation Discussed (Industry)", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "1 Signal", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["free in-home consultation (Agent)", "have a designer come out (Agent)", "measure your windows (Agent)"])',
          createdAt: "11/06/25 7:58 pm", updatedAt: "01/06/26 8:29 pm" },
        { name: "Motorization Interest", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "", description: "", taggedAs: "Lead", revenue: "",
          rules: 'voice_signal = any(1, ["motorized (Caller)", "remote control (Caller)", "smart home", "works with Alexa"])',
          createdAt: "07/22/25 9:07 pm", updatedAt: "01/12/26 5:09 pm" },
        { name: "Price Sensitive (Industry)", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "1 Scorecard", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["too expensive (Caller)", "cheaper option (Caller)", "out of my budget (Caller)", "shop around (Caller)"])',
          createdAt: "11/06/25 7:58 pm", updatedAt: "01/14/26 10:09 pm" },
        { name: "Product Interest: Shutters", status: "ACTIVE", types: "Keyword Spotting",
          usedIn: "1 Signal", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["plantation shutters", "shutters (Caller)", "faux wood shutters", "composite shutters"])',
          createdAt: "11/06/25 7:58 pm", updatedAt: "01/06/26 8:29 pm" },
        { name: "Quote Provided", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "", description: "", taggedAs: "Lead", revenue: "",
          rules: 'voice_signal = any(1, ["your total would be (Agent)", "comes out to (Agent)", "email you the quote (Agent)"])',
          createdAt: "04/27/25 11:46 am", updatedAt: "01/13/26 3:24 pm" },
        { name: "SALES CALL Needs Review", status: "ACTIVE", types: "Rules, Scorecard",
          usedIn: "1 Scorecard", description: "", taggedAs: "", revenue: "",
          rules: 'scorecard[SALES Call Handling Skills] < 60 and duration > 45 sec',
          createdAt: "06/12/25 4:23 pm", updatedAt: "01/14/26 8:01 am" },
        { name: "Score Card: Proper Greeting", status: "ACTIVE", types: "Keyword Spotting, Rules",
          usedIn: "3 Scorecards", description: "", taggedAs: "", revenue: "",
          rules: 'voice_signal = any(1, ["thank you for calling Shady Blinds (Agent)", "how can I help you today (Agent)"])',
          createdAt: "02/12/25 1:00 pm", updatedAt: "01/12/26 11:56 am" },
      ],
    },
    voiceRoutingDemo: {
      brandName: "Shady Blinds",
      brandDomain: "www.shadyblindsnow.com",
      brandIcon: "🪟",
      callerPhone: "+1 (805) 555-0142",
      callerLocation: "Santa Barbara, CA",
      idBadge: "New Visitor",
      attribution: [
        { label: "Source", value: "Google" },
        { label: "Medium", value: "Paid Search" },
        { label: "Campaign", value: "Custom Window Treatments, Santa Barbara" },
        { label: "Keyword", value: "motorized shades installation", highlight: true },
        { label: "Calling Page", value: "/motorized-shades", highlight: true },
        { label: "Device", value: "Mobile, iOS" },
      ],
      visitorHistory: [
        { label: "Pages Viewed", value: "Motorized Shades, Plantation Shutters", highlight: true },
        { label: "Quote Started", value: "Yes, not submitted", highlight: true },
        { label: "Location", value: "Santa Barbara, CA" },
      ],
      queues: [
        { id: "design_consult", name: "Design Consultation" },
        { id: "existing_order", name: "Existing Order, Support" },
        { id: "general", name: "General Support" },
      ],
      convo: [
        {
          role: "agent",
          text: "Thanks for calling Shady Blinds. Are you looking to start a new window treatment project, or do you need help with an existing order?",
          sigs: [],
          q: [50, 30, 20],
        },
        {
          role: "caller",
          text: "A new project. I'm interested in motorized shades for my living room and a couple of bedrooms.",
          sigs: [
            { c: "green", t: "<strong>New project</strong> - custom window treatments" },
            { c: "green", t: "<strong>Motorized shades</strong> - specific product requested" },
          ],
          q: [72, 16, 12],
        },
        {
          role: "agent",
          text: "Wonderful. We design and install custom motorized shades. About how many windows are you looking to cover, and what's your timeline?",
          sigs: [],
          q: [80, 12, 8],
        },
        {
          role: "caller",
          text: "Around six windows, and we're remodeling right now so fairly soon. I'm in Santa Barbara, ZIP 93109.",
          sigs: [
            { c: "green", t: "<strong>6 windows</strong> - high-value project" },
            { c: "orange", t: "<strong>Remodeling now</strong> - urgent timeline" },
            { c: "green", t: "<strong>Santa Barbara 93109</strong> - confirmed service area" },
          ],
          q: [95, 3, 2],
        },
        {
          role: "agent",
          text: "Perfect. Based on what you've shared, I'm connecting you with our design consultation team. They'll book a free in-home consultation to measure your windows and show you motorized shade samples.",
          sigs: [],
          q: [96, 2, 2],
        },
      ],
      routedSubtitle: "AI Agent qualified caller intent and matched to the right team",
    },
  },
};
