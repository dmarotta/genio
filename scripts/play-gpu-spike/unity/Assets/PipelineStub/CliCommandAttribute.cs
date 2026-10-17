using System;

namespace Unity.Pipeline.Commands
{
    /// <summary>Stand-in for com.unity.pipeline's attribute, so com.genio.play compiles in the scratch project without the package (the spike starts sessions directly, not through Pipeline).</summary>
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class CliCommandAttribute : Attribute
    {
        public CliCommandAttribute(string name, string description) { }
        public bool MainThreadRequired { get; set; }
    }
}
