/review You are doing a security review of my EatMeAI Next.js + Supabase app.

Focus on:

1. OWASP Top 10
2. Supabase RLS and policy correctness (deny by default, per-user row ownership)
3. Auth/session handling and least privilege (service role never exposed client-side)
4. User-controlled free text inputs: custom allergies and mitigation text boxes
   - model threats: stored XSS, HTML/markdown injection, SQL injection (including RPC), prompt injection (if AI used), log injection, abuse/spam
   - verify safe rendering (no dangerouslySetInnerHTML, unsafe markdown)
   - require server-side validation, output encoding, and sanitization
5. Rate limiting and abuse prevention
6. Safe error handling and no sensitive logging

Deliverables:

1. Executive security summary (highly detailed)

   - overall security posture (low, medium, high risk)
   - top 5 most critical risks
   - likely real-world attack scenarios
   - business impact if exploited
   - recommended priority order for fixes

2. Ranked list of vulnerabilities

   - severity (critical, high, medium, low)
   - exploit scenario
   - technical impact
   - affected files/components

3. Exact mitigations

   - concrete code changes
   - patches or diff-style suggestions
   - configuration changes

4. Input validation rules

   - length limits
   - allowed character sets
   - normalization rules
   - server-side enforcement examples

5. Supabase RLS review
   - table-by-table policy analysis
   - missing or unsafe policies
   - corrected SQL policies

Output format:

- Start with the executive summary
- Then vulnerabilities ranked by severity
- Then mitigations and code fixes
- Then validation rules
- Then RLS policy recommendations
